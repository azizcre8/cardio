import type { PageRecord, TextQuality } from '@/types';

const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PDF_PAGES = 750;

// ─── pdfjs-dist Configuration (Worker-Aware) ───────────────────────────────

async function getPdfjsLib() {
  const pdfjs = await import('pdfjs-dist/build/pdf');

  if (typeof window === 'undefined') {
    const pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.entry');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
  }

  return pdfjs;
}

// ─── Main Extraction Function ───────────────────────────────────────────────

function getPdfExtractionMessage(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = `${name} ${message}`.toLowerCase();

  if (lower.includes('password') || lower.includes('encrypted')) {
    return 'PDF is encrypted or password-protected. Upload an unlocked PDF and try again.';
  }
  if (lower.includes('invalid pdf') || lower.includes('corrupt') || lower.includes('malformed')) {
    return 'PDF could not be read. The file may be corrupt or not a valid PDF.';
  }
  return `PDF text extraction failed: ${message}`;
}

export const extractTextServer = async (buffer: Buffer): Promise<PageRecord[]> => {
  if (buffer.byteLength === 0) {
    throw new Error('Uploaded PDF is empty.');
  }
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error('PDF is too large to process. Upload a file under 80 MB or split it into smaller PDFs.');
  }

  const pdfjsLib = await getPdfjsLib();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      // Text-only extraction — skip font loading entirely.
      // Node.js fetch() doesn't support file:// URLs so standard font data
      // can't be loaded anyway, and fonts aren't needed for text extraction.
      useSystemFonts: true,
    }).promise;
  } catch (error) {
    throw new Error(getPdfExtractionMessage(error));
  }

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw new Error('PDF has too many pages to process in one upload. Split it into smaller PDFs and try again.');
  }

  const pages: PageRecord[] = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const c = await page.getTextContent();
      let text = '';
      let prev: { transform: number[] } | null = null;

      for (const item of c.items) {
        if (!('str' in item) || typeof item.str !== 'string' || !Array.isArray(item.transform)) continue;
        if (!item.str.trim()) continue;
        // Preserve line breaks by checking the y-coordinate (transform[5]).
        const y = typeof item.transform[5] === 'number' ? item.transform[5] : 0;
        const prevY = prev && typeof prev.transform[5] === 'number' ? prev.transform[5] : y;
        const yChanged = prev !== null && Math.abs(y - prevY) > 2;
        text += (yChanged ? '\n' : ' ') + item.str;
        prev = { transform: item.transform };
      }

      if (text.trim()) pages.push({ page: i, text: text.trim() });
    }
  } catch (error) {
    throw new Error(getPdfExtractionMessage(error));
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
