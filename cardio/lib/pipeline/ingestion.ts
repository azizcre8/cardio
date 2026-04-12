import type { PageRecord, TextQuality } from '@/types';

// ─── pdfjs-dist Configuration (Worker-Aware) ───────────────────────────────

async function getPdfjsLib() {
  // 1. Import the main library
  const pdfjs = await import('pdfjs-dist/build/pdf');
  
  // 2. Point to the worker entry point specifically for the server-side
  if (typeof window === 'undefined') {
    const pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.entry');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
  }
  
  return pdfjs;
}

// ─── Main Extraction Function ───────────────────────────────────────────────

export const extractTextServer = async (buffer: Buffer): Promise<PageRecord[]> => {
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
      // Preserve line breaks by checking the y-coordinate (transform[5])
      const yChanged = prev !== null && Math.abs(item.transform[5] - prev.transform[5]) > 2;
      text += (yChanged ? '\n' : ' ') + item.str;
      prev = item;
    }

    if (text.trim()) pages.push({ page: i, text: text.trim() });
  }

  return pages;
};

// ─── Quality Assessment ─────────────────────────────────────────────────────

export function assessTextQuality(pages: PageRecord[]) {
  if (!pages || !pages.length) {
    return { quality: 'empty' as const, avgCharsPerPage: 0, lowTextRatio: 1, totalChars: 0 };
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

  let quality: 'empty' | 'poor' | 'ok';
  if (avgCharsPerPage < 100)   quality = 'empty';
  else if (lowTextRatio > 0.4) quality = 'poor';
  else                         quality = 'ok';

  return { quality, avgCharsPerPage, lowTextRatio, totalChars };
}