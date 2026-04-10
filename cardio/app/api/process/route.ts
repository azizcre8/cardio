/**
 * POST /api/process — full 6-phase pipeline, SSE-streamed progress.
 *
 * Request: multipart/form-data { pdf: File, density: string }
 * Response: text/event-stream of ProcessEvent JSON objects
 *
 * Client reads via fetch() + ReadableStream (NOT EventSource — SSE only supports GET).
 */

import { NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { PLAN_LIMITS } from '@/lib/stripe';
import { extractTextServer, assessTextQuality } from '@/lib/pipeline/ingestion';
import { chunkText } from '@/lib/pipeline/chunking';
import { embedAllChunks } from '@/lib/pipeline/embeddings';
import { buildBM25Index } from '@/lib/pipeline/retrieval';
import { extractInventory, mergeInventory, canonicalizeConcepts, generateConfusionMap, toConceptRow } from '@/lib/pipeline/inventory';
import { generateCoverageQuestions } from '@/lib/pipeline/generation';
import { auditQuestions } from '@/lib/pipeline/audit';
import {
  insertPDF, updatePDF, insertChunks, insertConcepts, insertQuestions, insertFlaggedQuestion,
  getAndMaybeResetMonthlyCount, incrementMonthlyCount,
} from '@/lib/storage';
import type { ProcessEvent, Density, DensityConfig } from '@/types';
import { DENSITY_CONFIG } from '@/types';

export const maxDuration = 300; // Vercel Pro — upgrade to Supabase Edge Fn for longer jobs
export const runtime    = 'nodejs';

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function encodeEvent(ev: ProcessEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.id;

  // ── Parse form data
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response('Invalid form data', { status: 400 });
  }

  const pdfFile  = formData.get('pdf') as File | null;
  const density  = (formData.get('density') as Density | null) ?? 'standard';

  if (!pdfFile) return new Response('No PDF file', { status: 400 });
  if (!['standard', 'comprehensive', 'boards'].includes(density)) {
    return new Response('Invalid density', { status: 400 });
  }

  const dc: DensityConfig = DENSITY_CONFIG[density];

  // ── Plan limit check
  try {
    const monthlyCount = await getAndMaybeResetMonthlyCount(userId);
    // Fetch plan from profile
    const { data: profile } = await supabaseServer().from('users').select('plan').eq('id', userId).single();
    const tier = (profile?.plan as keyof typeof PLAN_LIMITS) ?? 'free';
    const limits = PLAN_LIMITS[tier];
    if (limits.pdfsPerMonth !== null && monthlyCount >= limits.pdfsPerMonth) {
      return new Response(
        JSON.stringify({ error: 'Plan limit exceeded', tier, limit: limits.pdfsPerMonth }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );
    }
  } catch (e) {
    return new Response(`Plan check failed: ${(e as Error).message}`, { status: 500 });
  }

  // Create PDF row immediately so we have an ID for the stream
  const pdfRow = await insertPDF({
    user_id:    userId,
    name:       pdfFile.name,
    page_count: 0,
    density,
    processed_at: null,
    processing_cost_usd: null,
    concept_count: null,
    question_count: null,
  });
  const pdfId = pdfRow.id;

  // ── Start SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (ev: ProcessEvent) => {
        controller.enqueue(new TextEncoder().encode(encodeEvent(ev)));
      };

      const fail = (msg: string) => {
        emit({ phase: 0, message: `Error: ${msg}`, pct: 0 });
        controller.close();
      };

      try {
        // ── Phase 1: Extract text
        emit({ phase: 1, message: 'Phase 1: Extracting text from PDF…', pct: 2 });

        const buffer = Buffer.from(await pdfFile.arrayBuffer());
        const pages  = await extractTextServer(buffer);

        if (!pages.length) {
          fail('PDF appears empty — no text could be extracted');
          return;
        }

        const enableQualityCheck = process.env.ENABLE_TEXT_QUALITY_CHECK !== 'false';
        if (enableQualityCheck) {
          const qr = assessTextQuality(pages);
          if (qr.quality === 'empty') {
            fail('PDF text quality is too poor (scanned/image PDF)');
            return;
          }
          if (qr.quality === 'poor') {
            emit({ phase: 1, message: 'Warning: PDF text quality is poor — results may be limited', pct: 4 });
          }
        }

        await updatePDF(pdfId, { page_count: pages.length });
        emit({ phase: 1, message: `Phase 1: Extracted ${pages.length} pages`, pct: 8 });

        // ── Phase 2: Chunk
        emit({ phase: 2, message: 'Phase 2: Chunking text…', pct: 10 });
        const rawChunks = chunkText(pages, dc.words, dc.overlap, pdfId);
        emit({ phase: 2, message: `Phase 2: ${rawChunks.length} chunks`, pct: 14 });

        // ── Phase 3: Embed
        emit({ phase: 3, message: 'Phase 3: Embedding chunks…', pct: 15 });
        const chunkRecords = await embedAllChunks(rawChunks, (done, total) => {
          const pct = 15 + Math.round((done / total) * 13);
          emit({ phase: 3, message: `Phase 3: Embedding ${done}/${total}…`, pct });
        });

        // Save chunks with embeddings
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

        // Build BM25 index in memory for this pipeline run
        const bm25Index = buildBM25Index(chunkRecords);
        emit({ phase: 3, message: 'Phase 3: Embeddings complete', pct: 28 });

        // ── Phase 4: Concept inventory
        emit({ phase: 4, message: 'Phase 4: Extracting concept inventory…', pct: 30 });

        const BATCH_SIZE = 3; // chunks per inventory call
        const inventories = [];
        const totalBatches = Math.ceil(chunkRecords.length / BATCH_SIZE);

        for (let b = 0; b < chunkRecords.length; b += BATCH_SIZE) {
          const batch = chunkRecords.slice(b, b + BATCH_SIZE);
          const inv = await extractInventory(batch, dc, Math.floor(b / BATCH_SIZE), totalBatches);
          inventories.push(inv);
          const pct = 30 + Math.round(((b + BATCH_SIZE) / chunkRecords.length) * 20);
          emit({ phase: 4, message: `Phase 4: Inventory batch ${Math.floor(b / BATCH_SIZE) + 1}/${totalBatches}`, pct: Math.min(pct, 50) });
        }

        const merged = mergeInventory(inventories, pdfId);
        const canonical = canonicalizeConcepts(merged);
        emit({ phase: 4, message: `Phase 4: ${canonical.length} concepts extracted`, pct: 52 });

        // ── Phase 5: Confusion map
        emit({ phase: 5, message: 'Phase 5: Building confusion map…', pct: 54 });
        const confusionMap = await generateConfusionMap(canonical.map(c => ({ name: c.name, category: c.category })));

        // Save concepts
        const conceptRows = canonical.map(c => toConceptRow(c, pdfId, userId));
        const savedConcepts = await insertConcepts(conceptRows);
        emit({ phase: 5, message: `Phase 5: ${savedConcepts.length} concepts saved`, pct: 58 });

        // ── Phase 6: Question generation + audit
        emit({ phase: 6, message: 'Phase 6: Generating questions…', pct: 60 });

        // Apply plan limits to question count
        const { data: profileRow } = await supabaseServer().from('users').select('plan').eq('id', userId).single();
        const tier = ((profileRow?.plan) as keyof typeof PLAN_LIMITS) ?? 'free';
        const maxQuestionsPerPdf = PLAN_LIMITS[tier].maxQuestionsPerPdf;

        let totalQuestions = 0;
        let totalCostUSD   = 0;
        const allPassedQuestions: Array<ReturnType<typeof generateCoverageQuestions> extends Promise<{ questions: Array<infer Q> }> ? Q : never> = [];

        // Build concept specs for generation
        const conceptSpecs = savedConcepts.map((c, i) => ({
          id:               c.id,
          name:             c.name,
          category:         c.category,
          importance:       c.importance,
          keyFacts:         (canonical[i]?.coverageDomain ? canonical[i]! : canonical.find(cc => cc.name === c.name) ?? canonical[i]!).keyFacts ?? [],
          clinicalRelevance: (canonical.find(cc => cc.name === c.name))?.clinicalRelevance ?? '',
          associations:     (canonical.find(cc => cc.name === c.name))?.associations ?? [],
          pageEstimate:     (canonical.find(cc => cc.name === c.name))?.pageEstimate ?? '',
          coverageDomain:   (canonical.find(cc => cc.name === c.name))?.coverageDomain ?? 'definition_recall',
          chunk_ids:        (canonical.find(cc => cc.name === c.name))?.sourceChunkIds ?? [],
        }));

        const GEN_BATCH = 3;
        for (let g = 0; g < conceptSpecs.length && totalQuestions < maxQuestionsPerPdf; g += GEN_BATCH) {
          const batch = conceptSpecs.slice(g, g + GEN_BATCH);
          const { questions: genQs, costUSD } = await generateCoverageQuestions(
            batch, pdfId, userId, dc, chunkRecords, confusionMap, bm25Index,
          );
          totalCostUSD += costUSD;

          // Audit
          const ragPassages: Record<string, string> = {};
          batch.forEach(c => {
            const chunks = chunkRecords.filter(ch => c.chunk_ids.includes(ch.id));
            ragPassages[c.id] = chunks.map(ch => ch.text.slice(0, 350)).join('\n\n');
          });

          const { passed, hardRejected, costUSD: auditCost } = await auditQuestions(
            genQs, batch, pdfId, userId, ragPassages,
          );
          totalCostUSD += auditCost;

          // Save hard-rejected questions to flagged table
          for (const hr of hardRejected) {
            await insertFlaggedQuestion({
              pdf_id:      pdfId,
              user_id:     userId,
              question_id: null,
              reason:      `${hr.criterion}: ${hr.critique}`,
              raw_json:    hr.lastQuestion as unknown as Record<string, unknown>,
            });
          }

          // Cap to plan limit
          const remaining = maxQuestionsPerPdf - totalQuestions;
          const toAdd = passed.slice(0, remaining);
          allPassedQuestions.push(...(toAdd as typeof allPassedQuestions));
          totalQuestions += toAdd.length;

          const pct = 60 + Math.round(((g + GEN_BATCH) / conceptSpecs.length) * 35);
          emit({
            phase: 6,
            message: `Phase 6: ${totalQuestions} questions (batch ${Math.floor(g / GEN_BATCH) + 1}/${Math.ceil(conceptSpecs.length / GEN_BATCH)})`,
            pct: Math.min(pct, 94),
          });
        }

        // Bulk insert all passed questions
        const savedQuestions = await insertQuestions(allPassedQuestions as Parameters<typeof insertQuestions>[0]);

        // Update PDF row with final stats
        await updatePDF(pdfId, {
          processed_at:        new Date().toISOString(),
          processing_cost_usd: totalCostUSD,
          concept_count:       savedConcepts.length,
          question_count:      savedQuestions.length,
        });

        // Increment monthly counter
        await incrementMonthlyCount(userId);

        emit({
          phase: 7,
          message: `Done! ${savedConcepts.length} concepts, ${savedQuestions.length} questions. Cost: $${totalCostUSD.toFixed(3)}`,
          pct: 100,
          data: { pdfId, conceptCount: savedConcepts.length, questionCount: savedQuestions.length, costUSD: totalCostUSD },
        });
      } catch (e) {
        fail((e as Error).message);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':   'keep-alive',
    },
  });
}
