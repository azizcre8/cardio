import { DENSITY_CONFIG } from '@/types';

export interface AnalyzeResult {
  pageCount: number;
  estimatedTotalWords: number;
  estimates: Record<string, {
    questionsMin: number;
    questionsMax: number;
    timeSec: number;
  }>;
}

export async function analyzePdfClient(file: File): Promise<AnalyzeResult> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;
  }

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pageCount = doc.numPages;

  const sampleCount = Math.min(3, pageCount);
  let sampleWords = 0;
  for (let i = 1; i <= sampleCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = (content.items as Array<{ str: string }>).map(it => it.str).join(' ');
    sampleWords += text.trim().split(/\s+/).filter(Boolean).length;
  }
  const avgPerPage = sampleCount > 0 ? sampleWords / sampleCount : 280;
  const estimatedTotalWords = Math.round(avgPerPage * pageCount);

  const CONCEPTS_PER_CHUNK = 5;
  const importanceDist = { high: 0.33, medium: 0.40, low: 0.27 };

  const estimates: AnalyzeResult['estimates'] = {};
  for (const [mode, cfg] of Object.entries(DENSITY_CONFIG)) {
    const chunks = Math.max(1, Math.ceil(estimatedTotalWords / cfg.words));
    const concepts = chunks * CONCEPTS_PER_CHUNK;
    const avgQsPerConcept = Object.entries(importanceDist).reduce((sum, [imp, frac]) => {
      const levels = cfg.levels[imp as keyof typeof cfg.levels] ?? [];
      return sum + frac * levels.length;
    }, 0);
    const questionsMin = Math.max(1, Math.round(concepts * avgQsPerConcept * 0.65));
    const questionsMax = Math.max(1, Math.round(concepts * avgQsPerConcept * 0.88));
    const timeSec = Math.round(concepts * 14 + 60);
    estimates[mode] = { questionsMin, questionsMax, timeSec };
  }

  return { pageCount, estimatedTotalWords, estimates };
}
