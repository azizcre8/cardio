/**
 * Phase 2 — Text chunking.
 * Structural chunker (heading/paragraph-aware) replaces pure word-window.
 * Original word-window chunker kept as fallback.
 */

import type { PageRecord, RawChunk } from '@/types';
import { env } from '@/lib/env';

const ENABLE_STRUCTURAL_CHUNKING = env.flags.structuralChunking;

export function chunkText(
  pages: PageRecord[],
  wordsPerChunk: number,
  overlapFraction: number,
  pdfId: string,
): RawChunk[] {
  if (ENABLE_STRUCTURAL_CHUNKING) return structuralChunkText(pages, wordsPerChunk, overlapFraction, pdfId);
  return wordWindowChunkText(pages, wordsPerChunk, overlapFraction, pdfId);
}

// ─── Original word-window chunker (kept as fallback) ─────────────────────────

function wordWindowChunkText(
  pages: PageRecord[],
  wordsPerChunk: number,
  overlapFraction: number,
  pdfId: string,
): RawChunk[] {
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

// ─── Structure-aware chunker ──────────────────────────────────────────────────
// Splits on headings/paragraph boundaries before merging micro-blocks.

interface Segment {
  text: string;
  page: number;
  isHeading?: boolean;
  isBullet?: boolean;
  isBreak?: boolean;
  wc?: number;
}

interface Block {
  lines: Segment[];
  startPage: number;
}

function structuralChunkText(
  pages: PageRecord[],
  wordsPerChunk: number,
  overlapFraction: number,
  pdfId: string,
): RawChunk[] {
  // Annotate each line
  const segments: Segment[] = [];
  pages.forEach(({ page, text }) => {
    const lines = text.split(/\n/);
    lines.forEach(line => {
      const t = line.trim();
      if (!t) { segments.push({ text: '', page, isBreak: true }); return; }
      const wc = t.split(/\s+/).length;
      const isAllCaps = t === t.toUpperCase() && /[A-Z]/.test(t) && wc <= 10;
      const isTitleCase = wc <= 10 && /^[A-Z]/.test(t) &&
        t.split(' ').filter(w => w.length > 3).every(w => /^[A-Z]/.test(w));
      const isBullet = /^[\u2022\-\*\d+\.]\s/.test(t);
      segments.push({ text: t, page, isHeading: isAllCaps || isTitleCase, isBullet, wc });
    });
  });

  // Group segments into structural blocks
  const blocks: Block[] = [];
  let cur: Segment[] = [];
  let curPage = pages[0]?.page ?? 1;

  segments.forEach(seg => {
    if (seg.isHeading && cur.length > 0) {
      if (cur.some(s => s.wc && s.wc > 0)) blocks.push({ lines: [...cur], startPage: curPage });
      cur = [seg];
      curPage = seg.page;
    } else if (seg.isBreak && cur.length > 2) {
      const wcSoFar = cur.reduce((s, x) => s + (x.wc ?? 0), 0);
      if (wcSoFar > wordsPerChunk * 0.6) {
        blocks.push({ lines: [...cur], startPage: curPage });
        cur = [];
        curPage = seg.page;
      } else {
        cur.push(seg);
      }
    } else {
      if (cur.length === 0) curPage = seg.page;
      cur.push(seg);
    }
  });
  if (cur.some(s => s.wc && s.wc > 0)) blocks.push({ lines: cur, startPage: curPage });

  // Merge small blocks, split oversized ones
  const minWords = Math.floor(wordsPerChunk * 0.25);
  const overlap = Math.floor(wordsPerChunk * overlapFraction);
  const chunks: RawChunk[] = [];
  let chunkIndex = 0;
  let pendingText = '';
  let pendingPage = 1;
  let pendingEndPage = 1;

  function flushPending() {
    if (!pendingText.trim()) return;
    const words = pendingText.trim().split(/\s+/);
    if (words.length < 20) return;
    if (words.length > wordsPerChunk * 1.5) {
      const step = wordsPerChunk - overlap;
      for (let i = 0; i < words.length; i += step) {
        const slice = words.slice(i, Math.min(i + wordsPerChunk, words.length));
        if (slice.length < 20) break;
        chunks.push({
          id: `${pdfId}_chunk_${chunkIndex++}`,
          pdf_id: pdfId,
          text: slice.join(' '),
          start_page: pendingPage,
          end_page: pendingEndPage,
          headers: [],
          word_count: slice.length,
        });
      }
    } else {
      chunks.push({
        id: `${pdfId}_chunk_${chunkIndex++}`,
        pdf_id: pdfId,
        text: pendingText.trim(),
        start_page: pendingPage,
        end_page: pendingEndPage,
        headers: [],
        word_count: words.length,
      });
    }
    pendingText = '';
  }

  blocks.forEach(block => {
    const blockText = block.lines.filter(s => s.wc && s.wc > 0).map(s => s.text).join(' ');
    const blockWords = blockText.split(/\s+/).length;
    const endPage = block.lines
      .filter(s => s.page)
      .reduce((p, s) => Math.max(p, s.page ?? 0), block.startPage);

    if (blockWords < minWords) {
      if (!pendingText) pendingPage = block.startPage;
      pendingText += ' ' + blockText;
      pendingEndPage = Math.max(pendingEndPage, endPage);
    } else {
      flushPending();
      pendingText = blockText;
      pendingPage = block.startPage;
      pendingEndPage = endPage;
      if (blockWords >= wordsPerChunk) flushPending();
    }
  });
  flushPending();

  // Annotate headers on each chunk
  return chunks.map(ch => {
    const lines = ch.text.split(/\s{2,}|\n/);
    const headers = lines.filter(l => {
      const t = l.trim();
      const wc = t.split(/\s+/).filter(Boolean).length;
      if (!wc || wc > 8 || t.length < 4) return false;
      return t === t.toUpperCase() && /[A-Z]/.test(t);
    }).map(l => l.trim()).slice(0, 3);
    return { ...ch, headers };
  });
}
