/**
 * Phase 3 — Embeddings.
 * Verbatim port of embedTexts() and embedAllChunks() from medical-study-app-v2.html.
 *
 * KEY DIFFERENCE FROM ORIGINAL: float truncation to 4 decimal places is REMOVED.
 * The original truncated to save localStorage space (~3x smaller).
 * pgvector stores float32 natively — full precision improves retrieval quality.
 */

import OpenAI from 'openai';
import type { RawChunk, ChunkRecord } from '@/types';
import { env } from '@/lib/env';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS  = 512;
const EBATCH      = 20;

function getOpenAI(): OpenAI {
  return new OpenAI({ apiKey: env.openAiApiKey });
}

// ─── embedTexts — verbatim port (uses SDK instead of raw fetch) ───────────────

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];

  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts.map(t => t.slice(0, 2000)),
    dimensions: EMBED_DIMS,
  });

  // Sort by index (API may reorder) and return float arrays
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(e => e.embedding);
}

// ─── embedAllChunks — verbatim port (truncation removed) ─────────────────────

export async function embedAllChunks(
  rawChunks: RawChunk[],
  onProgress?: (done: number, total: number) => void,
): Promise<ChunkRecord[]> {
  const records: ChunkRecord[] = rawChunks.map(c => ({
    ...c,
    embedding: [],
  }));

  for (let i = 0; i < records.length; i += EBATCH) {
    const batch = records.slice(i, i + EBATCH);
    try {
      const vecs = await embedTexts(batch.map(c => c.text));
      batch.forEach((c, j) => {
        // Full float32 precision — NO truncation (see module docstring)
        c.embedding = vecs[j]!;
      });
    } catch (e) {
      // Non-fatal: generation falls back to key-facts-only if no embedding
      console.warn(
        `Embedding batch ${Math.floor(i / EBATCH) + 1} failed (${(e as Error).message}) — RAG will be partial`,
      );
    }

    onProgress?.(Math.min(i + EBATCH, records.length), records.length);
  }

  return records;
}
