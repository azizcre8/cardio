/**
 * GET /api/study/summary
 * Returns per-PDF SRS counts (new, due, learning) for all user PDFs.
 */

import { requireUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

export interface PdfSrsSummary {
  new: number;      // questions never reviewed
  due: number;      // next_review <= now
  learning: number; // reviewed but next_review > now
}

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { supabase, userId } = auth;

  // All questions for this user (just id + pdf_id)
  const { data: questions, error: qErr } = await supabase
    .from('questions')
    .select('id, pdf_id')
    .eq('user_id', userId)
    .eq('flagged', false);

  if (qErr) return jsonError(qErr.message);

  // All SRS state for this user
  const { data: srsRows, error: sErr } = await supabase
    .from('srs_state')
    .select('question_id, pdf_id, next_review')
    .eq('user_id', userId);

  if (sErr) return jsonError(sErr.message);

  const now = new Date().toISOString();
  const srsMap = new Map((srsRows ?? []).map(s => [s.question_id as string, s as { next_review: string; pdf_id: string }]));

  const byPdf: Record<string, PdfSrsSummary> = {};

  for (const q of (questions ?? [])) {
    const pdfId = q.pdf_id as string;
    if (!byPdf[pdfId]) byPdf[pdfId] = { new: 0, due: 0, learning: 0 };
    const srs = srsMap.get(q.id as string);
    if (!srs) {
      byPdf[pdfId].new++;
    } else if (srs.next_review <= now) {
      byPdf[pdfId].due++;
    } else {
      byPdf[pdfId].learning++;
    }
  }

  return jsonOk({ byPdf });
}
