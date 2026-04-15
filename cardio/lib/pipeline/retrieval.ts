/**
 * Phase 4 — Retrieval (hybrid BM25 + pgvector dense search).
 * Verbatim port from medical-study-app-v2.html.
 *
 * Dense retrieval: calls `match_chunks` Supabase RPC (replaces in-memory cosineSimilarity loop).
 * BM25 retrieval: stays in-memory (rebuilt from DB-fetched chunks at pipeline start).
 * Fusion: Reciprocal Rank Fusion, RRF_K=60.
 */

import { supabaseAdmin } from '@/lib/supabase';
import type { ChunkRecord, BM25Index } from '@/types';
import { env } from '@/lib/env';

const RAG_TOP_K = 4;

// ─── Dense retrieval via pgvector RPC ────────────────────────────────────────

export async function denseSearch(
  queryEmbedding: number[],
  pdfId: string,
  topK = RAG_TOP_K * 2, // oversample before fusion
): Promise<ChunkRecord[]> {
  const { data, error } = await supabaseAdmin.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    pdf_id_filter: pdfId,
    match_count: topK,
  });

  if (error) throw new Error(`match_chunks RPC failed: ${error.message}`);

  return (data ?? []).map((row: {
    id: string; text: string; start_page: number;
    end_page: number; headers: string[]; similarity: number;
  }) => ({
    id: row.id,
    pdf_id: pdfId,
    text: row.text,
    start_page: row.start_page,
    end_page: row.end_page,
    headers: row.headers,
    word_count: row.text.split(/\s+/).length,
    embedding: [], // not returned by RPC; not needed post-retrieval
  } satisfies ChunkRecord));
}

// ─── BM25 index builder — verbatim from HTML ──────────────────────────────────

export function buildBM25Index(chunks: ChunkRecord[]): BM25Index {
  const k1 = 1.5, b = 0.75;
  const tokenize = (t: string) =>
    (t || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);

  const docTokens = chunks.map(c => tokenize(c.text));
  const docLens   = docTokens.map(t => t.length);
  const avgdl     = docLens.reduce((s, l) => s + l, 0) / (docLens.length || 1);

  // Build IDF: df per term
  const df: Record<string, number> = {};
  docTokens.forEach(tokens => {
    new Set(tokens).forEach(t => { df[t] = (df[t] ?? 0) + 1; });
  });

  const N = chunks.length;
  const idf: Record<string, number> = {};
  Object.keys(df).forEach(t => {
    idf[t] = Math.log((N - df[t]! + 0.5) / (df[t]! + 0.5) + 1);
  });

  // Build tf map: docId → term → count
  const tf = new Map<string, Map<string, number>>();
  const docLengths = new Map<string, number>();
  chunks.forEach((c, i) => {
    const counts = new Map<string, number>();
    docTokens[i]!.forEach(t => counts.set(t, (counts.get(t) ?? 0) + 1));
    tf.set(c.id, counts);
    docLengths.set(c.id, docLens[i]!);
  });

  const idfMap = new Map<string, number>(Object.entries(idf));

  return {
    tf,
    idf: idfMap,
    docLengths,
    avgDocLength: avgdl,
    docIds: chunks.map(c => c.id),
  };
}

// ─── BM25 search — verbatim from HTML ─────────────────────────────────────────

export function bm25Search(
  query: string,
  index: BM25Index,
  chunks: ChunkRecord[],
  k = 10,
): ChunkRecord[] {
  if (!index) return [];

  const k1 = 1.5, b = 0.75;
  const tokenize = (t: string) =>
    (t || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  const qTokens = tokenize(query);

  const scores = chunks.map(c => {
    const termFreqs = index.tf.get(c.id) ?? new Map<string, number>();
    const dl = index.docLengths.get(c.id) ?? 0;
    let score = 0;

    qTokens.forEach(qt => {
      const f = termFreqs.get(qt) ?? 0;
      if (!f) return;
      const idfVal = index.idf.get(qt) ?? 0;
      score += idfVal * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / index.avgDocLength));
    });

    return { chunk: c, score };
  });

  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.chunk);
}

// ─── Reciprocal Rank Fusion — verbatim from HTML ──────────────────────────────

export function reciprocalRankFusion(
  denseResults:  ChunkRecord[],
  sparseResults: ChunkRecord[],
  k = RAG_TOP_K,
): ChunkRecord[] {
  const RRF_K = 60;
  const scores: Record<string, number> = {};
  const byId:   Record<string, ChunkRecord> = {};

  denseResults.forEach((c, rank) => {
    scores[c.id] = (scores[c.id] ?? 0) + 1 / (RRF_K + rank + 1);
    byId[c.id] = c;
  });

  sparseResults.forEach((c, rank) => {
    scores[c.id] = (scores[c.id] ?? 0) + 1 / (RRF_K + rank + 1);
    byId[c.id] = byId[c.id] ?? c;
  });

  return Object.keys(scores)
    .map(id => byId[id]!)
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))
    .slice(0, k);
}

// ─── retrieveTopChunks — verbatim from HTML ───────────────────────────────────
// Hybrid when ENABLE_HYBRID_RETRIEVAL + bm25Index present; else dense-only.

export async function retrieveTopChunks(
  pdfId:         string,
  queryEmbedding: number[],
  queryText:     string,
  bm25Index:     BM25Index | null,
  allChunks:     ChunkRecord[],
  topK = RAG_TOP_K,
): Promise<ChunkRecord[]> {
  const enableHybrid = env.flags.hybridRetrieval;
  let denseRanked: ChunkRecord[] = [];
  try {
    denseRanked = await denseSearch(queryEmbedding, pdfId, topK * 2);
  } catch (error) {
    console.warn(`[retrieveTopChunks] dense retrieval unavailable, falling back: ${(error as Error).message}`);
  }

  if (enableHybrid && bm25Index && queryText) {
    const sparseRanked = bm25Search(queryText, bm25Index, allChunks, topK * 2);
    if (denseRanked.length) {
      return reciprocalRankFusion(denseRanked, sparseRanked, topK);
    }
    return sparseRanked.slice(0, topK);
  }

  if (denseRanked.length) {
    return denseRanked.slice(0, topK);
  }

  if (bm25Index && queryText) {
    return bm25Search(queryText, bm25Index, allChunks, topK);
  }

  return allChunks.slice(0, topK);
}
