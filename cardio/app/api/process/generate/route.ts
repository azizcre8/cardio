/**
 * POST /api/process/generate — phase 6 of the pipeline (question generation + audit + dedup).
 * Called by the client after /api/process (prepare) completes.
 *
 * Request: JSON { pdfId: string }
 * Response: text/event-stream of ProcessEvent JSON objects, ending with phase 7
 */

import { NextRequest } from 'next/server';
import { buildBM25Index } from '@/lib/pipeline/retrieval';
import { generateCoverageQuestions } from '@/lib/pipeline/generation';
import { auditQuestions } from '@/lib/pipeline/audit';
import { buildDistractorCandidatePool, formatDistractorCandidatePool } from '@/lib/pipeline/distractors';
import { dedupQuestions } from '@/lib/pipeline/dedup';
import { buildGenerationBatchFailureFlags } from '@/lib/pipeline/process-helpers';
import {
  getPDF, getChunks,
  insertQuestions, insertFlaggedQuestion, deleteQuestions,
  updatePDF, incrementMonthlyCount, getQuestions,
} from '@/lib/storage';
import {
  DENSITY_CONFIG, type ProcessEvent, type ConceptSpec, type ConfusionMap, type ImportanceLevel,
} from '@/types';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { getActivePdfJobByPdfId, finishPdfJobError, finishPdfJobSuccess, updatePdfJob } from '@/lib/pdf-jobs';
import { roundUsdAmount, type OpenAICostEvent } from '@/lib/openai-cost';

export const maxDuration = 300;
export const runtime    = 'nodejs';

function encodeEvent(ev: ProcessEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  let pdfId: string;
  try {
    ({ pdfId } = await req.json() as { pdfId: string });
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }
  if (!pdfId) return new Response('Missing pdfId', { status: 400 });

  const pdf = await getPDF(pdfId, userId);
  if (!pdf) return new Response('PDF not found', { status: 404 });

  const conceptSpecs = (pdf.concept_specs ?? []) as ConceptSpec[];
  const confusionMap = (pdf.confusion_map ?? {}) as ConfusionMap;
  const effectiveMax = pdf.effective_max_questions ?? 300;
  const dc = DENSITY_CONFIG[pdf.density];

  if (!conceptSpecs.length) {
    return new Response('PDF has no concept specs — run /api/process first', { status: 409 });
  }

  const pdfJob = await getActivePdfJobByPdfId(pdfId);

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      let runningOpenAICostUSD = 0;
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
          isClosed = true;
        }
      };

      const fail = (msg: string) => {
        emit({ phase: 0, message: `Error: ${msg}`, pct: 0 });
      };

      const INTERNAL_TIMEOUT_MS = 280_000;
      const timeoutHandle = setTimeout(() => {
        if (!isClosed) {
          void (async () => {
            try {
              if (pdfJob?.id) {
                await finishPdfJobError(pdfJob.id, {
                  question_count: latestQuestionCount,
                  openai_cost_usd: runningOpenAICostUSD,
                  error_message: 'Question generation timed out after 5 minutes. Try a lower density setting.',
                });
              }
            } catch { /* ignore */ }
            emit({ phase: 0, message: 'Error: Question generation timed out after 5 minutes. Try a lower density setting.', pct: 0 });
          })();
        }
      }, INTERNAL_TIMEOUT_MS);

      try {
        emit({ phase: 6, message: 'Phase 6: Loading chunks and building retrieval index…', pct: 60 });
        const chunkRecords = await getChunks(pdfId);
        const bm25Index = buildBM25Index(chunkRecords);

        const cappedConceptSpecs = conceptSpecs;

        if (cappedConceptSpecs.length > 1) {
          emit({
            phase: 6,
            message: `Phase 6: Generating questions for ${cappedConceptSpecs.length} concepts…`,
            pct: 61,
          });
        }

        let totalQuestions = 0;
        let totalRejected  = 0;
        const allPassedQuestions: any[] = [];
        const rejectionBreakdown: Record<string, number> = {};
        const conceptImportance: Record<string, string> = {};
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
            console.error(`[generate] Batch ${Math.floor(g / GEN_BATCH) + 1} failed:`, genErr);
            const failureFlags = buildGenerationBatchFailureFlags(batch, genErr);
            for (const failureFlag of failureFlags) {
              await insertFlaggedQuestion({
                pdf_id: pdfId,
                user_id: userId,
                question_id: null,
                reason: failureFlag.reason,
                raw_json: failureFlag.raw_json,
              });
            }
            totalRejected += failureFlags.length;
            rejectionBreakdown['GENERATION_BATCH_FAILED'] = (rejectionBreakdown['GENERATION_BATCH_FAILED'] ?? 0) + failureFlags.length;
          }

          const ragPassages: Record<string, string> = {};
          const ragChunks: Record<string, typeof chunkRecords> = {};
          const distractorGuides: Record<string, string> = {};
          batch.forEach(c => {
            const chunks = chunkRecords.filter(ch => c.chunk_ids.includes(ch.id));
            ragChunks[c.id] = chunks;
            ragPassages[c.id] = chunks.map(ch => ch.text).join('\n\n');
            const confusions = confusionMap[c.name] ?? [];
            const candidatePool = buildDistractorCandidatePool(
              {
                conceptId: c.id,
                conceptName: c.name,
                category: c.category,
                importance: c.importance as ImportanceLevel,
                level: 2,
                coverageDomain: c.coverageDomain,
                chunkIds: c.chunk_ids,
                pageEstimate: c.pageEstimate,
                keyFacts: c.keyFacts,
                clinicalRelevance: c.clinicalRelevance,
                associations: c.associations,
              },
              cappedConceptSpecs,
              confusions,
              [],
            );
            const candidateGuide = formatDistractorCandidatePool(candidatePool);
            const confusionGuide = confusions.length
              ? confusions.map(cf => `${cf.concept}: ${cf.reason}`).join('\n')
              : '';
            distractorGuides[c.id] = [candidateGuide, confusionGuide].filter(Boolean).join('\n');
          });

          let passed: any[] = [], hardRejected: { criterion: string; critique: string; lastQuestion: unknown }[] = [];
          try {
            const auditResult = await auditQuestions(genQs, batch, pdfId, userId, ragPassages, ragChunks, distractorGuides, recordCost);
            passed = auditResult.passed;
            hardRejected = auditResult.hardRejected;
          } catch (auditErr) {
            console.error(`[generate] Audit batch ${Math.floor(g / GEN_BATCH) + 1} failed:`, auditErr);
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
              pdf_id:   pdfId,
              user_id:  userId,
              question_id: null,
              reason:   `${hr.criterion}: ${hr.critique}`,
              raw_json: hr.lastQuestion as Record<string, unknown>,
            });
          }

          allPassedQuestions.push(...passed);
          totalQuestions += passed.length;
          totalRejected  += hardRejected.length + rejectedSlots.length;
          for (const hr of hardRejected) {
            const key = hr.criterion || 'UNKNOWN';
            rejectionBreakdown[key] = (rejectionBreakdown[key] ?? 0) + 1;
          }
          for (const _sf of rejectedSlots) {
            rejectionBreakdown['SLOT_GENERATION'] = (rejectionBreakdown['SLOT_GENERATION'] ?? 0) + 1;
          }

          const pct = 61 + Math.round(((g + GEN_BATCH) / cappedConceptSpecs.length) * 30);
          emit({
            phase: 6,
            message: `Phase 6: ${totalQuestions} accepted / ${totalQuestions + totalRejected} generated (batch ${Math.floor(g / GEN_BATCH) + 1}/${totalBatchCount})`,
            pct: Math.min(pct, 91),
            data: {
              questionsGenerated: totalQuestions + totalRejected,
              questionsAccepted:  totalQuestions,
              questionsRejected:  totalRejected,
              rejectionBreakdown,
            },
          });
        }

        // ── Quality-sort then dedup ──
        const importanceWeight: Record<string, number> = { high: 3, medium: 2, low: 1 };
        allPassedQuestions.sort((a, b) => {
          const levelDiff = (b.level ?? 1) - (a.level ?? 1);
          if (levelDiff !== 0) return levelDiff;
          const aImp = importanceWeight[conceptImportance[a.concept_id] ?? 'low'] ?? 1;
          const bImp = importanceWeight[conceptImportance[b.concept_id] ?? 'low'] ?? 1;
          return bImp - aImp;
        });

        const dedupResult = await dedupQuestions(allPassedQuestions, conceptImportance, recordCost);
        const totalDeduped = dedupResult.dropped.length;
        if (totalDeduped > 0) {
          emit({
            phase: 6,
            message: `Phase 6: Removed ${totalDeduped} near-duplicate question${totalDeduped === 1 ? '' : 's'}`,
            pct: 93,
            data: { deduped: totalDeduped },
          });
        }

        const finalQuestions = env.flags.slotBasedGeneration
          ? dedupResult.kept
          : dedupResult.kept.slice(0, effectiveMax);

        const savedQuestions = await insertQuestions(finalQuestions);
        latestQuestionCount = savedQuestions.length;

        // Clean up any stale questions from a previous (failed) attempt on this PDF
        const allStoredIds = new Set(savedQuestions.map(q => q.id));
        const allForPdf = await getQuestions(pdfId);
        const staleIds = allForPdf.map(q => q.id).filter(id => !allStoredIds.has(id));
        if (staleIds.length) await deleteQuestions(staleIds);

        await updatePDF(pdfId, {
          processed_at:        new Date().toISOString(),
          processing_cost_usd: runningOpenAICostUSD,
          question_count:      savedQuestions.length,
          // Clear pipeline state — no longer needed
          concept_specs:       null,
          confusion_map:       null,
        });

        await incrementMonthlyCount(userId);

        if (pdfJob?.id) {
          await finishPdfJobSuccess(pdfJob.id, {
            page_count:      pdf.page_count,
            concept_count:   conceptSpecs.length,
            question_count:  savedQuestions.length,
            openai_cost_usd: runningOpenAICostUSD,
          });
        }

        emit({
          phase: 7,
          message: `Done! ${conceptSpecs.length} concepts, ${savedQuestions.length} questions. Cost: $${runningOpenAICostUSD.toFixed(3)}`,
          pct: 100,
          data: {
            pdfId,
            conceptCount:       conceptSpecs.length,
            questionCount:      savedQuestions.length,
            questionsGenerated: totalQuestions + totalRejected,
            questionsAccepted:  savedQuestions.length,
            questionsRejected:  totalRejected,
            deduped:            totalDeduped,
            costUSD:            runningOpenAICostUSD,
          },
        });

      } catch (e) {
        console.error('[generate] Phase 6 crashed:', e);
        try {
          if (pdfJob?.id) {
            await finishPdfJobError(pdfJob.id, {
              question_count:  latestQuestionCount,
              openai_cost_usd: runningOpenAICostUSD,
              error_message:   (e as Error).message ?? String(e),
            });
          }
        } catch { /* ignore */ }
        fail((e as Error).message ?? String(e));
      } finally {
        clearTimeout(timeoutHandle);
        if (!isClosed) {
          try { controller.close(); } catch { /* ignore */ }
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
