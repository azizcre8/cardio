/**
 * POST /api/process — single-pass PDF ingestion and Claude question generation.
 *
 * Request: multipart/form-data { pdf: File, density: string }
 * Response: text/event-stream of ProcessEvent JSON objects
 */

import { NextRequest } from 'next/server';
import { extractTextServer, assessTextQuality } from '@/lib/pipeline/ingestion';
import { generateQuestionsWithClaude } from '@/lib/pipeline/claude-generation';
import {
  insertPDF,
  updatePDF,
  insertQuestions,
  getAndMaybeResetMonthlyCount,
  ensureUserProfile,
  incrementMonthlyCount,
} from '@/lib/storage';
import { PLAN_LIMITS, type ProcessEvent, type Density } from '@/types';
import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { getPlanLimits, normalizePlanTier } from '@/lib/plans';
import {
  createPdfJob,
  getActivePdfJobByPdfId,
  finishPdfJobError,
  finishPdfJobSuccess,
  updatePdfJob,
} from '@/lib/pdf-jobs';

export const maxDuration = 300;
export const runtime = 'nodejs';

function encodeEvent(ev: ProcessEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function roundUsdAmount(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function POST(req: NextRequest) {
  const requestStartMs = Date.now();
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

  const pdfFile = formData.get('pdf') as File | null;
  const density = (formData.get('density') as Density | null) ?? 'standard';

  if (!pdfFile) return new Response('No PDF file', { status: 400 });
  if (!['standard', 'comprehensive', 'boards'].includes(density)) {
    return new Response('Invalid density', { status: 400 });
  }

  const { data: profileRow } = await supabase.from('users').select('plan').eq('id', userId).single();
  const planTier = normalizePlanTier(profileRow?.plan);
  const planName = typeof profileRow?.plan === 'string' && profileRow.plan.trim()
    ? profileRow.plan
    : 'free';

  if (process.env.NODE_ENV !== 'development') {
    try {
      const monthlyCount = await getAndMaybeResetMonthlyCount(userId);
      const limits = getPlanLimits(profileRow?.plan);
      if (limits.pdfsPerMonth !== null && monthlyCount >= limits.pdfsPerMonth) {
        return new Response(
          JSON.stringify({ error: 'Plan limit exceeded', tier: planTier, limit: limits.pdfsPerMonth }),
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        );
      }
    } catch (e) {
      return new Response(`Plan check failed: ${(e as Error).message}`, { status: 500 });
    }
  }

  const pdfRow = await insertPDF({
    user_id: userId,
    name: pdfFile.name,
    page_count: 0,
    density,
    processed_at: null,
    processing_cost_usd: null,
    concept_count: null,
    question_count: null,
    deck_id: null,
    display_name: null,
    position: 0,
  });
  const pdfId = pdfRow?.id;
  if (!pdfId) {
    console.error('[process] insertPDF returned row without id:', pdfRow);
    return new Response('Failed to create PDF record (missing id)', { status: 500 });
  }

  const createdPdfJob = await createPdfJob({
    user_id: userId,
    pdf_id: pdfId,
    pdf_name: pdfFile.name,
    density,
    plan_name: planName,
  });

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      let timedOut = false;
      let runningCostUSD = 0;
      let latestPageCount = 0;
      let latestQuestionCount = 0;
      const encoder = new TextEncoder();

      const emit = (ev: ProcessEvent) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(ev)));
        } catch {
          isClosed = true;
        }
      };

      const fail = (msg: string) => {
        emit({ phase: 0, message: `Error: ${msg}`, pct: 0 });
      };

      const pdfJob = await getActivePdfJobByPdfId(pdfId) ?? createdPdfJob;
      const failJobAndStop = async (msg: string) => {
        if (pdfJob?.id) {
          await finishPdfJobError(pdfJob.id, {
            page_count: latestPageCount,
            question_count: latestQuestionCount,
            concept_count: 0,
            openai_cost_usd: runningCostUSD,
            error_message: msg,
          });
        }
        fail(msg);
      };

      const INTERNAL_TIMEOUT_MS = 200_000;
      const timeoutHandle = setTimeout(() => {
        if (!isClosed) {
          timedOut = true;
          void (async () => {
            await failJobAndStop('Processing timed out after 4 minutes. Try a shorter PDF or lower density setting.');
          })();
        }
      }, INTERNAL_TIMEOUT_MS);

      try {
        emit({ phase: 1, message: 'Phase 1: Extracting text from PDF…', pct: 5 });

        const buffer = Buffer.from(await pdfFile.arrayBuffer());
        const pages = await extractTextServer(buffer);

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
            emit({ phase: 1, message: 'Warning: PDF text quality is poor — results may be limited', pct: 10 });
          }
        }

        if (timedOut) return;
        await updatePDF(pdfId, { page_count: pages.length });
        if (timedOut) return;
        latestPageCount = pages.length;
        if (pdfJob?.id) {
          if (timedOut) return;
          await updatePdfJob(pdfJob.id, { page_count: pages.length });
          if (timedOut) return;
        }
        const pdfText = pages.map(page => page.text).join('\n\n');
        if (timedOut) return;
        emit({ phase: 1, message: `Phase 1: Extracted ${pages.length} pages`, pct: 30 });

        if (timedOut) return;
        emit({ phase: 2, message: 'Preparing document…', pct: 30 });

        if (timedOut) return;
        emit({ phase: 6, message: 'Generating questions with Claude…', pct: 60 });
        const targetCount = PLAN_LIMITS[planTier]?.maxQuestionsPerPdf ?? 50;
        const generationPromise = generateQuestionsWithClaude(
          pdfText,
          targetCount,
          pdfId,
          userId,
          message => emit({ phase: 6, message, pct: 60 }),
          requestStartMs,
        );
        const heartbeatHandle = setInterval(() => {
          if (isClosed) return;
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            isClosed = true;
          }
        }, 20_000);
        const { questions, costUSD } = await generationPromise.finally(() => {
          clearInterval(heartbeatHandle);
        });
        runningCostUSD = roundUsdAmount(costUSD);
        latestQuestionCount = questions.length;

        if (timedOut) return;
        await insertQuestions(questions);
        if (timedOut) return;
        await updatePDF(pdfId, {
          processed_at: new Date().toISOString(),
          question_count: questions.length,
          processing_cost_usd: runningCostUSD,
        });
        if (timedOut) return;
        await incrementMonthlyCount(userId);
        if (timedOut) return;

        if (pdfJob?.id) {
          if (timedOut) return;
          await finishPdfJobSuccess(pdfJob.id, {
            page_count: latestPageCount,
            concept_count: 0,
            question_count: questions.length,
            openai_cost_usd: runningCostUSD,
          });
          if (timedOut) return;
        }

        // Signal readiness so use-app-state.ts proceeds to call /api/process/generate (stub)
        if (timedOut) return;
        emit({
          phase: 6,
          message: 'Questions generated — finalising…',
          pct: 95,
          data: { readyForGenerate: true, pdfId, cappedConceptCount: 0 },
        });

        const questionsAccepted = questions.filter(q => !q.flagged).length;
        if (timedOut) return;
        emit({
          phase: 7,
          message: 'Done',
          pct: 100,
          data: {
            pdfId,
            questionCount: questions.length,
            questionsGenerated: questions.length,
            questionsAccepted,
            costUSD: runningCostUSD,
          },
        });
      } catch (e) {
        console.error('[process] Pipeline crashed:', e);
        try {
          if (pdfJob?.id) {
            await finishPdfJobError(pdfJob.id, {
              page_count: latestPageCount,
              question_count: latestQuestionCount,
              concept_count: 0,
              openai_cost_usd: runningCostUSD,
              error_message: (e as Error).message ?? String(e),
            });
          }
        } catch (jobError) {
          console.error('[process] Failed to persist pdf job error state:', jobError);
        }
        fail((e as Error).message ?? String(e));
      } finally {
        clearTimeout(timeoutHandle);
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
      'Connection': 'keep-alive',
    },
  });
}
