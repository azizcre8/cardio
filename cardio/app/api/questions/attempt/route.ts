/**
 * POST /api/questions/attempt
 * Logs a single question attempt row for analytics.
 *
 * Body: AttemptRequestBody
 */

import { NextRequest } from 'next/server';
import { insertQuestionAttempt } from '@/lib/storage';
import type { AttemptFlagReason, AttemptRequestBody, AttemptSource } from '@/types';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonNotFound, jsonOk, parseJsonBody } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';

const VALID_FLAG_REASONS = new Set(['wrong_answer_key', 'confusing_wording', 'out_of_scope', 'other']);
const VALID_SOURCES = new Set(['quiz', 'study']);

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<AttemptRequestBody>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const { questionId, pdfId, selectedOption, isCorrect, timeSpentMs, explanationHelpful, flagReason, source } = body;

  if (!questionId || typeof questionId !== 'string') return jsonBadRequest('questionId is required');
  if (!pdfId || typeof pdfId !== 'string') return jsonBadRequest('pdfId is required');
  if (typeof selectedOption !== 'number' || selectedOption < -1 || !Number.isInteger(selectedOption)) {
    return jsonBadRequest('selectedOption must be an integer >= -1');
  }
  if (typeof isCorrect !== 'boolean') return jsonBadRequest('isCorrect must be a boolean');
  if (typeof timeSpentMs !== 'number' || timeSpentMs < 0 || !Number.isInteger(timeSpentMs)) {
    return jsonBadRequest('timeSpentMs must be a non-negative integer');
  }
  if (flagReason != null && !VALID_FLAG_REASONS.has(flagReason)) {
    return jsonBadRequest('Invalid flagReason');
  }
  if (source != null && !VALID_SOURCES.has(source)) {
    return jsonBadRequest('Invalid source');
  }

  const access = await getAccessiblePdfForUser(pdfId, auth.userId);
  if (!access) return jsonNotFound('PDF not found');

  const { data: question, error: questionError } = await supabaseAdmin
    .from('questions')
    .select('id')
    .eq('id', questionId)
    .eq('pdf_id', pdfId)
    .eq('user_id', access.pdf.user_id)
    .maybeSingle();
  if (questionError) throw new Error(`questions/attempt lookup failed: ${questionError.message}`);
  if (!question) return jsonNotFound('Question not found');

  await insertQuestionAttempt({
    question_id:         questionId,
    user_id:             auth.userId,
    pdf_id:              pdfId,
    selected_option:     selectedOption,
    is_correct:          isCorrect,
    time_spent_ms:       timeSpentMs,
    explanation_helpful: explanationHelpful ?? null,
    flag_reason:         (flagReason ?? null) as AttemptFlagReason | null,
    source:              (source ?? 'quiz') as AttemptSource,
  });

  return jsonOk({ ok: true });
}
