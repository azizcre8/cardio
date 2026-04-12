/**
 * POST /api/process — full 6-phase pipeline, SSE-streamed progress.
 *
 * Request: multipart/form-data { pdf: File, density: string }
 * Response: text/event-stream of ProcessEvent JSON objects
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

export const maxDuration = 300; 
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

  try {
    const monthlyCount = await getAndMaybeResetMonthlyCount(userId);
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

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false; // Safety Valve 1: Track closure state

      const emit = (ev: ProcessEvent) => {
        if (isClosed) return; // Don't send data if closed
        try {
          controller.enqueue(new TextEncoder().encode(encodeEvent(ev)));
        } catch (e) {
          console.error("Stream enqueue error:", e);
        }
      };

      const fail = (msg: string) => {
        emit({ phase: 0, message: `Error: ${msg}`, pct: 0 });
        // Safety Valve 2: We no longer call controller.close() here. 
        // We let the 'finally' block handle it exclusively.
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

        const conceptRows = canonical.map(c => toConceptRow(c, pdfId, userId));
        const savedConcepts = await insertConcepts(conceptRows);
        emit({ phase: 5, message: `Phase 5: ${savedConcepts.length} concepts saved`, pct: 58 });

        // ── Phase 6: Question generation + audit
        emit({ phase: 6, message: 'Phase 6: Generating questions…', pct: 60 });

        const { data: profileRow } = await supabaseServer().from('users').select('plan').eq('id', userId).single();
        const genTier = ((profileRow?.plan) as keyof typeof PLAN_LIMITS) ?? 'free';
        const maxQuestionsPerPdf = PLAN_LIMITS[genTier].maxQuestionsPerPdf;

        let totalQuestions = 0;
        let totalCostUSD   = 0;
        const allPassedQuestions: any[] = [];

        const conceptSpecs = savedConcepts.map((c, i) => ({
          id:               c.id,
          name:             c.name,
          category:         c.category,
          importance:       c.importance,
          keyFacts:         (canonical[i]?.coverageDomain ? canonical[i]! : canonical.find(cc => cc.name === c.name) ?? canonical[i]!).keyFacts ?? [],
          clinicalRelevance: (canonical.find(cc => cc.name === c.name))?.clinicalRelevance ?? '',
          associations:      (canonical.find(cc => cc.name === c.name))?.associations ?? [],
          pageEstimate:      (canonical.find(cc => cc.name === c.name))?.pageEstimate ?? '',
          coverageDomain:    (canonical.find(cc => cc.name === c.name))?.coverageDomain ?? 'definition_recall',
          chunk_ids:         (canonical.find(cc => cc.name === c.name))?.sourceChunkIds ?? [],
        }));

        const GEN_BATCH = 3;
        for (let g = 0; g < conceptSpecs.length && totalQuestions < maxQuestionsPerPdf; g += GEN_BATCH) {
          const batch = conceptSpecs.slice(g, g + GEN_BATCH);
          const { questions: genQs, costUSD } = await generateCoverageQuestions(
            batch, pdfId, userId, dc, chunkRecords, confusionMap, bm25Index,
          );
          totalCostUSD += costUSD;

          const ragPassages: Record<string, string> = {};
          batch.forEach(c => {
            const chunks = chunkRecords.filter(ch => c.chunk_ids.includes(ch.id));
            ragPassages[c.id] = chunks.map(ch => ch.text.slice(0, 350)).join('\n\n');
          });

          const { passed, hardRejected, costUSD: auditCost } = await auditQuestions(
            genQs, batch, pdfId, userId, ragPassages,
          );
          totalCostUSD += auditCost;

          for (const hr of hardRejected) {
            await insertFlaggedQuestion({
              pdf_id:      pdfId,
              user_id:      userId,
              question_id: null,
              reason:      `${hr.criterion}: ${hr.critique}`,
              raw_json:    hr.lastQuestion as unknown as Record<string, unknown>,
            });
          }

          const remaining = maxQuestionsPerPdf - totalQuestions;
          const toAdd = passed.slice(0, remaining);
          allPassedQuestions.push(...toAdd);
          totalQuestions += toAdd.length;

          const pct = 60 + Math.round(((g + GEN_BATCH) / conceptSpecs.length) * 35);
          emit({
            phase: 6,
            message: `Phase 6: ${totalQuestions} questions (batch ${Math.floor(g / GEN_BATCH) + 1}/${Math.ceil(conceptSpecs.length / GEN_BATCH)})`,
            pct: Math.min(pct, 94),
          });
        }

        const savedQuestions = await insertQuestions(allPassedQuestions);

        await updatePDF(pdfId, {
          processed_at:        new Date().toISOString(),
          processing_cost_usd: totalCostUSD,
          concept_count:        savedConcepts.length,
          question_count:       savedQuestions.length,
        });

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
        // Safety Valve 3: The ONLY place the controller closes. 
        // We check isClosed to prevent the ERR_INVALID_STATE error.
        if (!isClosed) {
          try {
            controller.close();
          } catch (e) {
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