/**
 * Phase 1 — PDF ingestion (server-side).
 *
 * Uses pdfjs-dist in Node mode (NOT pdf-parse) to preserve the per-page
 * y-coordinate structure that extractTextServer() relies on for newline detection.
 * This exactly mirrors extractText() in medical-study-app-v2.html.
 */

import type { PageRecord, TextQuality } from '@/types';

// ─── pdfjs-dist Node configuration ───────────────────────────────────────────
// Disable the Web Worker (not available in Node) and suppress GlobalWorkerOptions warning.

async function getPdfjsLib() {
  // Dynamic import keeps pdfjs out of browser bundles.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.js');
  // @ts-expect-error — GlobalWorkerOptions is defined at runtime
  pdfjs.GlobalWorkerOptions.workerSrc = '';
  return pdfjs;
}

// ─── extractTextServer — verbatim port of extractText() ──────────────────────
// Key: uses item.transform[5] (y-coordinate) to detect line breaks,
// which pdf-parse discards.

export async function extractTextServer(buffer: Buffer): Promise<PageRecord[]> {
  const pdfjsLib = await getPdfjsLib();

  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages: PageRecord[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const c = await page.getTextContent();
    let text = '';
    let prev: { transform: number[] } | null = null;

    for (const item of c.items as Array<{ str: string; transform: number[] }>) {
      if (!item.str.trim()) continue;
      const yChanged = prev !== null && Math.abs(item.transform[5] - prev.transform[5]) > 2;
      text += (yChanged ? '\n' : ' ') + item.str;
      prev = item;
    }

    if (text.trim()) pages.push({ page: i, text: text.trim() });
  }

  return pages;
}

// ─── assessTextQuality — verbatim port ───────────────────────────────────────

export interface TextQualityResult {
  quality: TextQuality;
  avgCharsPerPage: number;
  lowTextRatio: number;
  totalChars: number;
}

export function assessTextQuality(pages: PageRecord[]): TextQualityResult {
  if (!pages || !pages.length) {
    return { quality: 'empty', avgCharsPerPage: 0, lowTextRatio: 1, totalChars: 0 };
  }

  const totalChars = pages.reduce((s, p) => s + (p.text || '').length, 0);
  const avgCharsPerPage = totalChars / pages.length;

  const lowPages = pages.filter(p => {
    const t = p.text || '';
    if (t.length < 50) return true;
    const nonAscii = Array.from(t).filter(c => c.charCodeAt(0) > 127).length;
    return nonAscii / t.length > 0.15;
  }).length;

  const lowTextRatio = lowPages / pages.length;

  let quality: TextQuality;
  if (avgCharsPerPage < 100)   quality = 'empty';
  else if (lowTextRatio > 0.4) quality = 'poor';
  else                         quality = 'ok';

  return { quality, avgCharsPerPage, lowTextRatio, totalChars };
}
