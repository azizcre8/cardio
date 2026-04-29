/**
 * GET /api/pdfs/[id]/questions — fetch all questions for a PDF (shuffled)
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import { QUIZ_QUESTION_SELECT, flattenQuizQuestion, shuffleInPlace } from '@/lib/quiz-questions';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const access = await getAccessiblePdfForUser(params.id, auth.userId);
  if (!access) return jsonNotFound('PDF not found');

  const { data, error } = await supabaseAdmin
    .from('questions')
    .select(QUIZ_QUESTION_SELECT)
    .eq('pdf_id', params.id)
    .eq('user_id', access.pdf.user_id)
    .eq('flagged', false);

  if (error) return jsonError(error.message);

  const questions = shuffleInPlace((data ?? []).map((q: Record<string, unknown>) => flattenQuizQuestion(q)));

  return jsonOk({ questions });
}
