/**
 * POST /api/study/submit
 * Applies SRS to a question after a study session answer.
 * Handles dual-SRS for proxied (sibling-rotation) questions.
 *
 * Body: { questionId, quality, pdfId, proxiedFromId? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase';
import { upsertSRSState, insertReview, getUserProfile } from '@/lib/storage';
import { applySRS } from '@/lib/srs';
import type { SubmitQualityBody, Question, SRSState } from '@/types';

async function fetchQuestionWithSRS(questionId: string, userId: string): Promise<Question | null> {
  const { data: q } = await supabaseAdmin.from('questions').select('*').eq('id', questionId).single();
  if (!q) return null;

  const { data: s } = await supabaseAdmin
    .from('srs_state')
    .select('*')
    .eq('question_id', questionId)
    .eq('user_id', userId)
    .single();

  if (!s) return q as Question;

  return {
    ...q,
    interval:        s.interval,
    ease_factor:     s.ease_factor,
    repetitions:     s.repetitions,
    next_review:     s.next_review,
    last_reviewed:   s.last_reviewed,
    times_reviewed:  s.times_reviewed,
    times_correct:   s.times_correct,
    times_incorrect: s.times_incorrect,
    quality_history: s.quality_history,
  } as Question;
}

function buildSRSState(q: Question, userId: string, pdfId: string): Omit<SRSState, 'id' | 'updated_at'> {
  return {
    user_id:         userId,
    question_id:     q.id,
    pdf_id:          pdfId,
    interval:        q.interval ?? 0.17,
    ease_factor:     q.ease_factor ?? 2.5,
    repetitions:     q.repetitions ?? 0,
    next_review:     q.next_review ?? new Date().toISOString(),
    last_reviewed:   new Date().toISOString(),
    times_reviewed:  (q.times_reviewed ?? 0),
    times_correct:   (q.times_correct ?? 0),
    times_incorrect: (q.times_incorrect ?? 0),
    quality_history: [...(q.quality_history ?? []), 0], // placeholder; set below
  };
}

export async function POST(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  let body: SubmitQualityBody;
  try {
    body = await req.json() as SubmitQualityBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { questionId, quality, pdfId, proxiedFromId } = body;

  if (!questionId || !pdfId || typeof quality !== 'number' || quality < 1 || quality > 4) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const profile = await getUserProfile(userId);
  const examDate = profile?.exam_date ? new Date(profile.exam_date) : null;

  // ── Apply SRS to the answered question
  const answeredQ = await fetchQuestionWithSRS(questionId, userId);
  if (!answeredQ) return NextResponse.json({ error: 'Question not found' }, { status: 404 });

  const updatedQ = applySRS(answeredQ, quality, examDate);

  // Track correct/incorrect (quality >= 2 = not wrong = correct)
  const isCorrect = quality >= 2;
  const newTimesReviewed  = (answeredQ.times_reviewed ?? 0) + 1;
  const newTimesCorrect   = (answeredQ.times_correct  ?? 0) + (isCorrect ? 1 : 0);
  const newTimesIncorrect = (answeredQ.times_incorrect ?? 0) + (isCorrect ? 0 : 1);
  const newQualityHistory = [...(answeredQ.quality_history ?? []), quality];

  const srsState: Omit<SRSState, 'id' | 'updated_at'> = {
    user_id:         userId,
    question_id:     questionId,
    pdf_id:          pdfId,
    interval:        updatedQ.interval ?? 0.17,
    ease_factor:     updatedQ.ease_factor ?? 2.5,
    repetitions:     updatedQ.repetitions ?? 0,
    next_review:     updatedQ.next_review ?? new Date().toISOString(),
    last_reviewed:   new Date().toISOString(),
    times_reviewed:  newTimesReviewed,
    times_correct:   newTimesCorrect,
    times_incorrect: newTimesIncorrect,
    quality_history: newQualityHistory,
  };

  await upsertSRSState(srsState);

  await insertReview({
    user_id:       userId,
    question_id:   questionId,
    pdf_id:        pdfId,
    quality,
    interval_after: updatedQ.interval ?? 0.17,
    ease_after:    updatedQ.ease_factor ?? 2.5,
  });

  // ── Dual-SRS: if this was a proxied sibling and quality >= 3,
  // advance the ORIGINAL due question's schedule too.
  // Do NOT increment timesReviewed/timesCorrect on the original — only advance schedule.
  if (proxiedFromId && quality >= 3) {
    const origQ = await fetchQuestionWithSRS(proxiedFromId, userId);
    if (origQ) {
      const updatedOrig = applySRS(origQ, quality, examDate);
      await upsertSRSState({
        user_id:         userId,
        question_id:     proxiedFromId,
        pdf_id:          pdfId,
        interval:        updatedOrig.interval ?? 0.17,
        ease_factor:     updatedOrig.ease_factor ?? 2.5,
        repetitions:     updatedOrig.repetitions ?? 0,
        next_review:     updatedOrig.next_review ?? new Date().toISOString(),
        last_reviewed:   new Date().toISOString(),
        // Do NOT increment timesReviewed/timesCorrect — only schedule advances
        times_reviewed:  origQ.times_reviewed ?? 0,
        times_correct:   origQ.times_correct  ?? 0,
        times_incorrect: origQ.times_incorrect ?? 0,
        quality_history: origQ.quality_history ?? [],
      });
    }
  }

  return NextResponse.json({
    interval:    updatedQ.interval,
    ease_factor: updatedQ.ease_factor,
    repetitions: updatedQ.repetitions,
    next_review: updatedQ.next_review,
  });
}
