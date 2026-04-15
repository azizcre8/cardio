/**
 * POST /api/process — full 6-phase pipeline, SSE-streamed progress.
 *
 * Request: multipart/form-data { pdf: File, density: string }
 * Response: text/event-stream of ProcessEvent JSON objects
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { extractTextServer, assessTextQuality } from '@/lib/pipeline/ingestion';
import { chunkText } from '@/lib/pipeline/chunking';
import { embedAllChunks } from '@/lib/pipeline/embeddings';
import { buildBM25Index } from '@/lib/pipeline/retrieval';
import { extractInventory, mergeInventory, canonicalizeConcepts, generateConfusionMap, toConceptRow } from '@/lib/pipeline/inventory';
import { generateCoverageQuestions } from '@/lib/pipeline/generation';
import { auditQuestions } from '@/lib/pipeline/audit';
import {
  insertPDF, updatePDF, insertChunks, insertConcepts, insertQuestions, insertFlaggedQuestion,
  getAndMaybeResetMonthlyCount, incrementMonthlyCount, ensureUserProfile,
} from '@/lib/storage';
import { DENSITY_CONFIG, type ProcessEvent, type Density, type DensityConfig } from '@/types';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { getPlanLimits, normalizePlanTier } from '@/lib/plans';
import { createPdfJob, finishPdfJobError, finishPdfJobSuccess, updatePdfJob } from '@/lib/pdf-jobs';
import { roundUsdAmount, type OpenAICostEvent } from '@/lib/openai-cost';

export const maxDuration = 300; 
export const runtime    = 'nodejs';

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function encodeEvent(ev: ProcessEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { supabase, userId } = auth;
  await ensureUserProfile(userId, auth.session.user.email ?? '');

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response('Invalid form data', { status: 400 });
  }

  const pdfFile       = formData.get('pdf') as File | null;
  const density       = (formData.get('density') as Density | null) ?? 'standard';
  const maxQStr       = formData.get('maxQuestions') as string | null;
  const userMaxQ      = maxQStr ? Math.max(0, parseInt(maxQStr, 10) || 0) : 0;

  if (!pdfFile) return new Response('No PDF file', { status: 400 });
  if (!['standard', 'comprehensive', 'boards'].includes(density)) {
    return new Response('Invalid density', { status: 400 });
  }

  const dc: DensityConfig = DENSITY_CONFIG[density];
  const { data: profileRow } = await supabase.from('users').select('plan').eq('id', userId).single();
  const planName = typeof profileRow?.plan === 'string' && profileRow.plan.trim()
    ? profileRow.plan
    : 'free';

  if (process.env.NODE_ENV !== 'development') {
    try {
      const monthlyCount = await getAndMaybeResetMonthlyCount(userId);
      const limits = getPlanLimits(profileRow?.plan);
      if (limits.pdfsPerMonth !== null && monthlyCount >= limits.pdfsPerMonth) {
        return new Response(
          JSON.stringify({ error: 'Plan limit exceeded', tier: normalizePlanTier(profileRow?.plan), limit: limits.pdfsPerMonth }),
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        );
      }
    } catch (e) {
      return new Response(`Plan check failed: ${(e as Error).message}`, { status: 500 });
    }
  }

  const pdfRow = await insertPDF({
    user_id:    userId,
    name:       pdfFile.name,
    page_count: 0,
    density,
    processed_at: null,
    processing_cost_usd: null,
    concept_count: null,
    question_count: null,
    deck_id:      null,
    display_name: null,
    position:     0,
  });
  const pdfId = pdfRow?.id;
  if (!pdfId) {
    console.error('[process] insertPDF returned row without id:', pdfRow);
    return new Response('Failed to create PDF record (missing id)', { status: 500 });
  }

  const pdfJob = await createPdfJob({
    user_id: userId,
    pdf_id: pdfId,
    pdf_name: pdfFile.name,
    density,
    plan_name: planName,
  });

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false; // Safety Valve 1: Track closure state
      let runningOpenAICostUSD = 0;
      let latestPageCount = 0;
      let latestConceptCount = 0;
      let latestQuestionCount = 0;

      const recordCost = async (event: OpenAICostEvent) => {
        if (!(event.costUSD > 0)) return;
        runningOpenAICostUSD = roundUsdAmount(runningOpenAICostUSD + event.costUSD);
        if (pdfJob?.id) {
          await updatePdfJob(pdfJob.id, { openai_cost_usd: runningOpenAICostUSD });
        }
      };

      const emit = (ev: ProcessEvent) => {
        if (isClosed) return;
        try {
          controller.enqueue(new TextEncoder().encode(encodeEvent(ev)));
        } catch {
          // Controller closed externally (client disconnect) — mark closed and stop emitting
          isClosed = true;
        }
      };

      const fail = (msg: string) => {
        emit({ phase: 0, message: `Error: ${msg}`, pct: 0 });
        // Safety Valve 2: We no longer call controller.close() here. 
        // We let the 'finally' block handle it exclusively.
      };

      const failJobAndStop = async (msg: string) => {
        if (pdfJob?.id) {
          await finishPdfJobError(pdfJob.id, {
            page_count: latestPageCount,
            concept_count: latestConceptCount,
            question_count: latestQuestionCount,
            openai_cost_usd: runningOpenAICostUSD,
            error_message: msg,
          });
        }
        fail(msg);
      };

      try {
        // ── Phase 1: Extract text
        emit({ phase: 1, message: 'Phase 1: Extracting text from PDF…', pct: 2 });

        const buffer = Buffer.from(await pdfFile.arrayBuffer());
        const pages  = await extractTextServer(buffer);

        if (!pages.length) {
          await failJobAndStop('PDF appears empty — no text could be extracted');
          return;
        }

        if (env.flags.textQualityCheck) {
          const qr = assessTextQuality(pages);
          if (qr.quality === 'empty') {
            await failJobAndStop('PDF text quality is too poor (scanned/image PDF)');
            return;
          }
          if (qr.quality === 'poor') {
            emit({ phase: 1, message: 'Warning: PDF text quality is poor — results may be limited', pct: 4 });
          }
        }

        await updatePDF(pdfId, { page_count: pages.length });
        latestPageCount = pages.length;
        if (pdfJob?.id) {
          await updatePdfJob(pdfJob.id, { page_count: pages.length });
        }
        emit({ phase: 1, message: `Phase 1: Extracted ${pages.length} pages`, pct: 8 });

        // ── Phase 2: Chunk
        emit({ phase: 2, message: 'Phase 2: Chunking text…', pct: 10 });
        const rawChunks = chunkText(pages, dc.words, dc.overlap, pdfId);
        const totalWords = rawChunks.reduce((s, c) => s + c.word_count, 0);
        emit({ phase: 2, message: `Phase 2: ${rawChunks.length} chunks`, pct: 14, data: { wordsParsed: totalWords } });

        // ── Phase 3: Embed
        emit({ phase: 3, message: 'Phase 3: Embedding chunks…', pct: 15 });
        const chunkRecords = await embedAllChunks(rawChunks, (done, total) => {
          const pct = 15 + Math.round((done / total) * 13);
          emit({ phase: 3, message: `Phase 3: Embedding ${done}/${total}…`, pct });
        }, recordCost);

        await insertChunks(
          chunkRecords.map(c => ({
            id:         c.id,
            pdf_id:     pdfId,
            user_id:    userId,
            text:       c.text,
            start_page: c.start_page,
            end_page:   c.end_page,
            headers:    c.headers,
            word_count: c.word_count,
            embedding:  c.embedding,
          })),
        );

        const bm25Index = buildBM25Index(chunkRecords);
        emit({ phase: 3, message: 'Phase 3: Embeddings complete', pct: 28 });

        // ── Phase 4: Concept inventory
        emit({ phase: 4, message: 'Phase 4: Extracting concept inventory…', pct: 30 });

        const BATCH_SIZE = 3; 
        const inventories = [];
        const totalBatches = Math.ceil(chunkRecords.length / BATCH_SIZE);

        for (let b = 0; b < chunkRecords.length; b += BATCH_SIZE) {
          const batch = chunkRecords.slice(b, b + BATCH_SIZE);
          const inv = await extractInventory(batch, dc, Math.floor(b / BATCH_SIZE), totalBatches, recordCost);
          inventories.push(inv);
          const conceptsSoFar = inventories.reduce((s, inv) => s + (inv?.concepts?.length ?? 0), 0);
          const pct = 30 + Math.round(((b + BATCH_SIZE) / chunkRecords.length) * 20);
          emit({ phase: 4, message: `Phase 4: Inventory batch ${Math.floor(b / BATCH_SIZE) + 1}/${totalBatches}`, pct: Math.min(pct, 50), data: { conceptsGenerated: conceptsSoFar } });
        }

        const merged = mergeInventory(inventories, pdfId);
        const canonical = canonicalizeConcepts(merged);
        emit({ phase: 4, message: `Phase 4: ${canonical.length} concepts extracted`, pct: 52 });

        // ── Phase 5: Confusion map
        emit({ phase: 5, message: 'Phase 5: Building confusion map…', pct: 54 });
        const confusionMap = await generateConfusionMap(
          canonical.map(c => ({ name: c.name, category: c.category })),
          recordCost,
        );

        // Verify the PDF row is still visible to supabaseAdmin before inserting concepts
        const { data: pdfCheck } = await supabaseAdmin
          .from('pdfs').select('id').eq('id', pdfId).single();
        if (!pdfCheck) {
          throw new Error(`PDF record ${pdfId} not found in database before inserting concepts — userId: ${userId}`);
        }

        const conceptRows = canonical.map(c => toConceptRow(c, pdfId, userId));
        const savedConcepts = await insertConcepts(conceptRows);
        latestConceptCount = savedConcepts.length;
        emit({ phase: 5, message: `Phase 5: ${savedConcepts.length} concepts saved`, pct: 58 });

        // ── Phase 6: Question generation + audit
        emit({ phase: 6, message: 'Phase 6: Generating questions…', pct: 60 });

        const maxQuestionsPerPdf = getPlanLimits(profileRow?.plan).maxQuestionsPerPdf;
        const effectiveMax = userMaxQ > 0
          ? Math.min(userMaxQ, maxQuestionsPerPdf)
          : maxQuestionsPerPdf;

        let totalQuestions = 0;
        let totalRejected  = 0;
        const allPassedQuestions: any[] = [];
        /* map concept_id → importance for quality sorting */
        const conceptImportance: Record<string, string> = {};

        const canonicalByName = new Map(canonical.map(c => [c.name, c]));
        const conceptSpecs = savedConcepts.map(c => {
          const can = canonicalByName.get(c.name);
          return {
            id:               c.id,
            name:             c.name,
            category:         c.category,
            importance:       c.importance,
            keyFacts:         can?.keyFacts ?? [],
            clinicalRelevance: can?.clinicalRelevance ?? '',
            associations:      can?.associations ?? [],
            pageEstimate:      can?.pageEstimate ?? '',
            coverageDomain:    can?.coverageDomain ?? 'definition_recall',
            chunk_ids:         can?.sourceChunkIds ?? [],
          };
        });

        /* ── Cap concepts before generation to prevent runaway pipelines ──
         * Sort high → medium → low importance so the most critical concepts
         * are always included when the PDF has hundreds of concepts.
         * In development mode we skip the cap to allow full testing.            */
        const importanceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        const sortedConceptSpecs = [...conceptSpecs]
          .sort((a, b) => (importanceOrder[a.importance] ?? 2) - (importanceOrder[b.importance] ?? 2));

        let cappedConceptSpecs = sortedConceptSpecs;
        if (process.env.NODE_ENV !== 'development') {
          if (env.flags.slotBasedGeneration) {
            let slotBudget = 0;
            cappedConceptSpecs = [];
            for (const concept of sortedConceptSpecs) {
              const requiredLevels = dc.levels[concept.importance as keyof typeof dc.levels] ?? [1, 2];
              if (slotBudget > 0 && slotBudget + requiredLevels.length > effectiveMax) break;
              if (!slotBudget && requiredLevels.length > effectiveMax) {
                cappedConceptSpecs.push(concept);
                slotBudget += requiredLevels.length;
                break;
              }
              cappedConceptSpecs.push(concept);
              slotBudget += requiredLevels.length;
            }
          } else {
            // Aim for ~2× question budget in raw generation (audit rejects ~30-50%)
            const avgQPerConcept = (dc.min + dc.max) / 2;
            const byBudget = Math.ceil((maxQuestionsPerPdf * 2) / avgQPerConcept);
            const maxConcepts = Math.min(Math.max(byBudget, 20), 80); // floor=20, ceil=80
            cappedConceptSpecs = sortedConceptSpecs.slice(0, maxConcepts);
          }
        }

        if (cappedConceptSpecs.length < conceptSpecs.length) {
          emit({ phase: 6, message: `Phase 6: Processing top ${cappedConceptSpecs.length}/${conceptSpecs.length} concepts by importance`, pct: 60 });
        }

        /* register concept importance for quality sorting later */
        cappedConceptSpecs.forEach(c => { conceptImportance[c.id] = c.importance; });

        const GEN_BATCH = 3;
        for (let g = 0; g < cappedConceptSpecs.length; g += GEN_BATCH) {
          const batch = cappedConceptSpecs.slice(g, g + GEN_BATCH);
          const totalBatchCount = Math.ceil(cappedConceptSpecs.length / GEN_BATCH);

          let genQs: any[] = [];
          let rejectedSlots: Array<{ conceptId: string; conceptName: string; level: number; reason: string; raw: Record<string, unknown> | null }> = [];
          try {
            const result = await generateCoverageQuestions(
              batch, pdfId, userId, dc, chunkRecords, confusionMap, bm25Index, cappedConceptSpecs, recordCost,
            );
            genQs = result.questions;
            rejectedSlots = result.rejectedSlots;
          } catch (genErr) {
            console.error(`[process] Generation batch ${Math.floor(g / GEN_BATCH) + 1} failed:`, genErr);
          }

          const ragPassages: Record<string, string> = {};
          const distractorGuides: Record<string, string> = {};
          batch.forEach(c => {
            const chunks = chunkRecords.filter(ch => c.chunk_ids.includes(ch.id));
            ragPassages[c.id] = chunks.map(ch => ch.text.slice(0, 350)).join('\n\n');
            const confusions = confusionMap[c.name] ?? [];
            distractorGuides[c.id] = confusions.length
              ? confusions.map(confusion => `${confusion.concept}: ${confusion.reason}`).join('\n')
              : '';
          });

          let passed: any[] = [], hardRejected: any[] = [];
          try {
            const auditResult = await auditQuestions(genQs, batch, pdfId, userId, ragPassages, distractorGuides, recordCost);
            passed = auditResult.passed;
            hardRejected = auditResult.hardRejected;
          } catch (auditErr) {
            console.error(`[process] Audit batch ${Math.floor(g / GEN_BATCH) + 1} failed:`, auditErr);
          }

          for (const slotFailure of rejectedSlots) {
            await insertFlaggedQuestion({
              pdf_id: pdfId,
              user_id: userId,
              question_id: null,
              reason: `SLOT_GENERATION: ${slotFailure.conceptName} L${slotFailure.level} — ${slotFailure.reason}`,
              raw_json: (slotFailure.raw ?? {
                conceptId: slotFailure.conceptId,
                conceptName: slotFailure.conceptName,
                level: slotFailure.level,
              }) as Record<string, unknown>,
            });
          }

          for (const hr of hardRejected) {
            await insertFlaggedQuestion({
              pdf_id:      pdfId,
              user_id:      userId,
              question_id: null,
              reason:      `${hr.criterion}: ${hr.critique}`,
              raw_json:    hr.lastQuestion as unknown as Record<string, unknown>,
            });
          }

          allPassedQuestions.push(...passed);
          totalQuestions += passed.length;
          totalRejected  += hardRejected.length + rejectedSlots.length;
          latestQuestionCount = totalQuestions;

          const pct = 60 + Math.round(((g + GEN_BATCH) / cappedConceptSpecs.length) * 35);
          emit({
            phase: 6,
            message: `Phase 6: ${totalQuestions} questions (batch ${Math.floor(g / GEN_BATCH) + 1}/${totalBatchCount})`,
            pct: Math.min(pct, 94),
            data: { questionsGenerated: totalQuestions, questionsRejected: totalRejected },
          });
        }

        /* Quality-sort then apply plan cap and user cap */
        const importanceWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
        allPassedQuestions.sort((a: any, b: any) => {
          const levelDiff = (b.level ?? 1) - (a.level ?? 1);
          if (levelDiff !== 0) return levelDiff;
          const aImp = importanceWeight[conceptImportance[a.concept_id] ?? 'low'] ?? 1;
          const bImp = importanceWeight[conceptImportance[b.concept_id] ?? 'low'] ?? 1;
          return bImp - aImp;
        });

        const finalQuestions = env.flags.slotBasedGeneration
          ? allPassedQuestions
          : allPassedQuestions.slice(0, effectiveMax);

        const savedQuestions = await insertQuestions(finalQuestions);

        await updatePDF(pdfId, {
          processed_at:        new Date().toISOString(),
          processing_cost_usd: runningOpenAICostUSD,
          concept_count:        savedConcepts.length,
          question_count:       savedQuestions.length,
        });
        latestQuestionCount = savedQuestions.length;

        await incrementMonthlyCount(userId);
        if (pdfJob?.id) {
          await finishPdfJobSuccess(pdfJob.id, {
            page_count: latestPageCount,
            concept_count: savedConcepts.length,
            question_count: savedQuestions.length,
            openai_cost_usd: runningOpenAICostUSD,
          });
        }

        emit({
          phase: 7,
          message: `Done! ${savedConcepts.length} concepts, ${savedQuestions.length} questions. Cost: $${runningOpenAICostUSD.toFixed(3)}`,
          pct: 100,
          data: { pdfId, conceptCount: savedConcepts.length, questionCount: savedQuestions.length, costUSD: runningOpenAICostUSD },
        });

      } catch (e) {
        console.error('[process] Pipeline crashed:', e);
        try {
          if (pdfJob?.id) {
            await finishPdfJobError(pdfJob.id, {
              page_count: latestPageCount,
              concept_count: latestConceptCount,
              question_count: latestQuestionCount,
              openai_cost_usd: runningOpenAICostUSD,
              error_message: (e as Error).message ?? String(e),
            });
          }
        } catch (jobError) {
          console.error('[process] Failed to persist pdf job error state:', jobError);
        }
        fail((e as Error).message ?? String(e));
      } finally {
        // Safety Valve 3: The ONLY place the controller closes. 
        // We check isClosed to prevent the ERR_INVALID_STATE error.
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // ignore
          }
          isClosed = true;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
