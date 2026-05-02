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

  const estimates: AnalyzeResult['estimates'] = {};
  for (const [mode, cfg] of Object.entries(DENSITY_CONFIG)) {
    const chunks = Math.max(1, Math.ceil(estimatedTotalWords / cfg.words));
    const targetQuestions = Math.max(1, Math.round(pageCount * cfg.questionsPerPage));
    const questionsMin = Math.max(1, Math.round(targetQuestions * 0.75));
    const questionsMax = Math.max(1, Math.round(targetQuestions * 1.25));
    const timeSec = Math.round(targetQuestions * 5 + chunks * 10 + 60);
    estimates[mode] = { questionsMin, questionsMax, timeSec };
  }

  return { pageCount, estimatedTotalWords, estimates };
}
