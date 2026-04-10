/**
 * Phase 2 — Text chunking.
 * Verbatim port of chunkText() from medical-study-app-v2.html.
 */

import type { PageRecord, RawChunk } from '@/types';

// ─── chunkText — verbatim port ────────────────────────────────────────────────

export function chunkText(
  pages: PageRecord[],
  wordsPerChunk: number,
  overlapFraction: number,
  pdfId: string,
): RawChunk[] {
  // Build flat word list with page provenance
  const wordList: Array<{ w: string; page: number }> = [];
  pages.forEach(({ page, text }) => {
    text.split(/\s+/).filter(w => w.length > 0).forEach(w => wordList.push({ w, page }));
  });

  const overlap = Math.floor(wordsPerChunk * overlapFraction);
  const step = wordsPerChunk - overlap;
  const chunks: RawChunk[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < wordList.length; i += step) {
    let end = Math.min(i + wordsPerChunk, wordList.length);

    // Extend up to 40 words to land on a sentence boundary
    const maxExtend = Math.min(end + 40, wordList.length);
    while (end < maxExtend && !/[.?!]$/.test(wordList[end - 1]!.w)) end++;

    const slice = wordList.slice(i, end);
    if (slice.length < 20) {
      if (end >= wordList.length) break;
      continue;
    }

    const text = slice.map(e => e.w).join(' ');
    const startPage = slice[0]!.page;
    const endPage   = slice[slice.length - 1]!.page;

    // Detect section headers: short lines (≤8 words), all-caps or Title Case
    const lines = text.split('\n');
    const headers = lines
      .filter(l => {
        const t = l.trim();
        const wc = t.split(/\s+/).filter(Boolean).length;
        if (!wc || wc > 8 || t.length < 4) return false;
        const isAllCaps = t === t.toUpperCase() && /[A-Z]/.test(t);
        const isTitleCase =
          /^[A-Z]/.test(t) &&
          t.split(' ').filter(w => w.length > 3).every(w => /^[A-Z]/.test(w));
        return isAllCaps || isTitleCase;
      })
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 3);

    chunks.push({
      id: `${pdfId}_chunk_${chunkIndex}`,
      pdf_id: pdfId,
      text,
      start_page: startPage,
      end_page: endPage,
      headers,
      word_count: slice.length,
    });

    chunkIndex++;
    if (end >= wordList.length) break;
  }

  return chunks;
}
