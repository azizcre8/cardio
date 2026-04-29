/**
 * GET /api/decks/[id]/questions - fetch all questions for an owned deck and its subdecks.
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { getDeckAndDescendantIds } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import { QUIZ_QUESTION_SELECT, flattenQuizQuestion, shuffleInPlace } from '@/lib/quiz-questions';
import type { PDF } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: deck, error: deckError } = await supabaseAdmin
    .from('decks')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (deckError) return jsonError(deckError.message);
  if (!deck) return jsonNotFound('Deck not found');

  const deckIds = await getDeckAndDescendantIds(supabaseAdmin, auth.userId, params.id);
  const { data: pdfRows, error: pdfError } = deckIds.length > 0
    ? await supabaseAdmin
      .from('pdfs')
      .select('id')
      .eq('user_id', auth.userId)
      .in('deck_id', deckIds)
    : { data: [], error: null };

  if (pdfError) return jsonError(pdfError.message);

  const pdfIds = ((pdfRows ?? []) as Pick<PDF, 'id'>[]).map(pdf => pdf.id);
  if (pdfIds.length === 0) return jsonOk({ questions: [] });

  const { data, error } = await supabaseAdmin
    .from('questions')
    .select(QUIZ_QUESTION_SELECT)
    .eq('user_id', auth.userId)
    .in('pdf_id', pdfIds)
    .eq('flagged', false);

  if (error) return jsonError(error.message);

  return jsonOk({
    questions: shuffleInPlace((data ?? []).map((q: Record<string, unknown>) => flattenQuizQuestion(q))),
  });
}
