/**
 * POST /api/analyze — quick PDF scan for page count, word estimate, and
 * per-mode question/time estimates. Used by the Add tab before full processing.
 */

import { NextRequest } from 'next/server';
import { DENSITY_CONFIG } from '@/types';

export const maxDuration = 30;
export const runtime    = 'nodejs';

async function getPdfjsLib() {
  const pdfjs = await import('pdfjs-dist/build/pdf');
  if (typeof window === 'undefined') {
    const pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.entry');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
  }
  return pdfjs;
}

export interface AnalyzeResult {
  pageCount: number;
  estimatedTotalWords: number;
  estimates: Record<string, {
    questionsMin: number;
    questionsMax: number;
    timeSec: number;
  }>;
}

export async function POST(req: NextRequest) {
  let formData: FormData;
  try { formData = await req.formData(); }
  catch { return new Response('Invalid form data', { status: 400 }); }

  const pdfFile = formData.get('pdf') as File | null;
  if (!pdfFile) return new Response('No PDF file', { status: 400 });

  try {
    const buffer   = Buffer.from(await pdfFile.arrayBuffer());
    const pdfjsLib = await getPdfjsLib();
    const doc      = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    }).promise;

    const pageCount = doc.numPages;

    /* Sample first 3 pages for word density */
    const sampleCount = Math.min(3, pageCount);
    let sampleWords   = 0;
    for (let i = 1; i <= sampleCount; i++) {
      const page    = await doc.getPage(i);
      const content = await page.getTextContent();
      const text    = (content.items as Array<{ str: string }>).map(it => it.str).join(' ');
      sampleWords  += text.trim().split(/\s+/).filter(Boolean).length;
    }
    const avgPerPage           = sampleCount > 0 ? sampleWords / sampleCount : 280;
    const estimatedTotalWords  = Math.round(avgPerPage * pageCount);

    /* Per-mode estimates */
    const CONCEPTS_PER_CHUNK = 5;
    const importanceDist     = { high: 0.33, medium: 0.40, low: 0.27 };

    const estimates: AnalyzeResult['estimates'] = {};
    for (const [mode, cfg] of Object.entries(DENSITY_CONFIG)) {
      const chunks   = Math.max(1, Math.ceil(estimatedTotalWords / cfg.words));
      const concepts = chunks * CONCEPTS_PER_CHUNK;

      /* avg questions per concept from the levels config */
      const avgQsPerConcept = Object.entries(importanceDist).reduce((sum, [imp, frac]) => {
        const levels = cfg.levels[imp as keyof typeof cfg.levels] ?? [];
        return sum + frac * levels.length;
      }, 0);

      const questionsMin = Math.max(1, Math.round(concepts * avgQsPerConcept * 0.65));
      const questionsMax = Math.max(1, Math.round(concepts * avgQsPerConcept * 0.88));
      const timeSec      = Math.round(concepts * 14 + 60);

      estimates[mode] = { questionsMin, questionsMax, timeSec };
    }

    const result: AnalyzeResult = { pageCount, estimatedTotalWords, estimates };
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(`Analysis failed: ${(e as Error).message}`, { status: 500 });
  }
}
