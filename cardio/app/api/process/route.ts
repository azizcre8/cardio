/**
 * POST /api/process — phases 1-5 of the pipeline (prepare).
 * Phase 6 (question generation) runs in /api/process/generate after this stream closes.
 *
 * Request: multipart/form-data { pdf: File, density: string, maxQuestions?: string }
 * Response: text/event-stream of ProcessEvent JSON objects
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { extractTextServer, assessTextQuality } from '@/lib/pipeline/ingestion';
import { chunkText } from '@/lib/pipeline/chunking';
import { embedAllChunks } from '@/lib/pipeline/embeddings';
import { mergeInventory, canonicalizeConcepts, generateConfusionMap, toConceptRow } from '@/lib/pipeline/inventory';
import {
  extractInventoriesResilient,
  sortConceptsByImportanceAndName,
  summarizePipelineFailure,
} from '@/lib/pipeline/process-helpers';
import {
  insertPDF, updatePDF, insertChunks, insertConcepts,
  getAndMaybeResetMonthlyCount, ensureUserProfile,
} from '@/lib/storage';
import { DENSITY_CONFIG, type ProcessEvent, type Density, type DensityConfig, type ConceptSpec } from '@/types';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { getPlanLimits, normalizePlanTier } from '@/lib/plans';
import { createPdfJob, finishPdfJobError, updatePdfJob } from '@/lib/pdf-jobs';
import { roundUsdAmount, type OpenAICostEvent } from '@/lib/openai-cost';

export const maxDuration = 300; // hobby plan max; upgrade to pro for longer PDF jobs
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

      // Fire 20s before Vercel's hard 300s kill so we can send a clean error event.
      const INTERNAL_TIMEOUT_MS = 280_000;
      let timeoutAbortController: AbortController | null = new AbortController();
      const timeoutHandle = setTimeout(() => {
        timeoutAbortController = null;
        if (!isClosed) {
          void (async () => {
            try {
              if (pdfJob?.id) {
                await finishPdfJobError(pdfJob.id, {
                  page_count: latestPageCount,
                  concept_count: latestConceptCount,
                  question_count: latestQuestionCount,
                  openai_cost_usd: runningOpenAICostUSD,
                  error_message: 'Processing timed out after 5 minutes. Try a shorter PDF or lower density setting.',
                });
              }
            } catch { /* ignore */ }
            emit({ phase: 0, message: 'Error: Processing timed out after 5 minutes. Try a shorter PDF or a lower density setting.', pct: 0 });
          })();
        }
      }, INTERNAL_TIMEOUT_MS);

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

        const persistedChunkRows = chunkRecords.map(c => ({
          id:         c.id,
          pdf_id:     pdfId,
          user_id:    userId,
          text:       c.text,
          start_page: c.start_page,
          end_page:   c.end_page,
          headers:    c.headers,
          word_count: c.word_count,
          embedding:  c.embedding,
        }));

        await insertChunks(persistedChunkRows);
        emit({ phase: 3, message: 'Phase 3: Embeddings complete', pct: 28 });

        // ── Phase 4: Concept inventory
        emit({ phase: 4, message: 'Phase 4: Extracting concept inventory…', pct: 30 });
        const { inventories, warnings: inventoryWarnings } = await extractInventoriesResilient(chunkRecords, dc, recordCost);
        const totalBatches = Math.ceil(chunkRecords.length / 3);

        inventories.forEach((inv, idx) => {
          const conceptsSoFar = inventories
            .slice(0, idx + 1)
            .reduce((sum, inventory) => sum + (inventory?.concepts?.length ?? 0), 0);
          const pct = 30 + Math.round((((idx + 1) * 3) / chunkRecords.length) * 20);
          emit({
            phase: 4,
            message: `Phase 4: Inventory batch ${idx + 1}/${totalBatches}`,
            pct: Math.min(pct, 50),
            data: { conceptsGenerated: conceptsSoFar },
          });
        });

        for (const warning of inventoryWarnings) {
          console.warn(`[process] Inventory batch ${warning.batchIndex + 1}/${totalBatches} failed: ${warning.message}`);
          emit({
            phase: 4,
            message: `Phase 4: Skipped inventory batch ${warning.batchIndex + 1}/${totalBatches} after parse failure`,
            pct: 50,
            data: { warning: warning.message, chunkIds: warning.chunkIds },
          });
        }

        const inventoryFailure = summarizePipelineFailure(inventoryWarnings.map(warning => warning.message));
        if (inventoryFailure) {
          await failJobAndStop(inventoryFailure);
          return;
        }

        const merged = mergeInventory(inventories, pdfId);
        const canonical = canonicalizeConcepts(merged);
        if (!canonical.length) {
          const emptyInventoryFailure = summarizePipelineFailure(inventoryWarnings.map(warning => warning.message))
            ?? 'Concept extraction produced zero concepts. Check the OpenAI configuration and processing logs before retrying.';
          await failJobAndStop(emptyInventoryFailure);
          return;
        }
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

        // ── Build concept specs (needed by phase 6) ──
        const maxQuestionsPerPdf = getPlanLimits(profileRow?.plan).maxQuestionsPerPdf;
        const effectiveMax = userMaxQ > 0
          ? Math.min(userMaxQ, maxQuestionsPerPdf)
          : maxQuestionsPerPdf;

        const canonicalByName = new Map(canonical.map(c => [c.name, c]));
        const conceptSpecs: ConceptSpec[] = savedConcepts.map(c => {
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
            coverageDomain:    can?.coverageDomain ?? 'entity_recall',
            chunk_ids:         can?.sourceChunkIds ?? [],
          };
        });

        const sortedConceptSpecs = sortConceptsByImportanceAndName(conceptSpecs);
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
            const avgQPerConcept = (dc.min + dc.max) / 2;
            const byBudget = Math.ceil((maxQuestionsPerPdf * 2) / avgQPerConcept);
            const maxConcepts = Math.min(Math.max(byBudget, 20), 80);
            cappedConceptSpecs = sortedConceptSpecs.slice(0, maxConcepts);
          }
        }

        // ── Store pipeline state so /api/process/generate can resume ──
        await updatePDF(pdfId, {
          concept_specs:            cappedConceptSpecs as unknown[],
          confusion_map:            confusionMap as Record<string, unknown>,
          effective_max_questions:  effectiveMax,
          concept_count:            savedConcepts.length,
        });

        if (pdfJob?.id) {
          await updatePdfJob(pdfJob.id, {
            concept_count:    savedConcepts.length,
            openai_cost_usd:  runningOpenAICostUSD,
          });
        }

        // Signal client to call /api/process/generate
        emit({
          phase: 6,
          message: `Concepts ready. Starting question generation…`,
          pct: 59,
          data: {
            pdfId,
            readyForGenerate: true,
            conceptCount: savedConcepts.length,
            cappedConceptCount: cappedConceptSpecs.length,
            prepCostUSD: runningOpenAICostUSD,
          },
        });

      } catch (e) {
        console.error('[process/prepare] Pipeline crashed:', e);
        try {
          if (pdfJob?.id) {
            await finishPdfJobError(pdfJob.id, {
              page_count: latestPageCount,
              concept_count: latestConceptCount,
              question_count: 0,
              openai_cost_usd: runningOpenAICostUSD,
              error_message: (e as Error).message ?? String(e),
            });
          }
        } catch (jobError) {
          console.error('[process/prepare] Failed to persist pdf job error state:', jobError);
        }
        fail((e as Error).message ?? String(e));
      } finally {
        clearTimeout(timeoutHandle);
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
