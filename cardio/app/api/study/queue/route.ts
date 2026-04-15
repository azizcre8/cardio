/**
 * GET /api/study/queue?pdfId=<uuid>
 * Returns an adaptive study queue for the given PDF, with SRS state merged.
 */

import { NextRequest } from 'next/server';
import { getExamDeadlineForPdf } from '@/lib/storage';
import { buildQueue, computeAllMastery } from '@/lib/srs';
import type { Concept, Question, QueueResponse, SRSState } from '@/types';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonError, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

function mergeQuestionsWithSrs(questions: Question[], srsRows: SRSState[]): Question[] {
  const srsMap = new Map(srsRows.map(row => [row.question_id, row]));

  return questions.map(question => {
    const srs = srsMap.get(question.id);
    if (!srs) return question;

    return {
      ...question,
      interval: srs.interval,
      ease_factor: srs.ease_factor,
      repetitions: srs.repetitions,
      next_review: srs.next_review,
      last_reviewed: srs.last_reviewed,
      times_reviewed: srs.times_reviewed,
      times_correct: srs.times_correct,
      times_incorrect: srs.times_incorrect,
      quality_history: srs.quality_history,
    };
  });
}

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const pdfId = req.nextUrl.searchParams.get('pdfId');
  if (!pdfId) return jsonBadRequest('pdfId required');

  const userId = auth.userId;

  const [questionRes, conceptRes, profileRes, srsRes, deckDeadline] = await Promise.all([
    auth.supabase.from('questions').select('*').eq('pdf_id', pdfId).eq('flagged', false),
    auth.supabase.from('concepts').select('*').eq('pdf_id', pdfId),
    auth.supabase.from('users').select('exam_date').eq('id', userId).single(),
    auth.supabase.from('srs_state').select('*').eq('pdf_id', pdfId).eq('user_id', userId),
    getExamDeadlineForPdf(pdfId),
  ]);

  if (questionRes.error) return jsonError(questionRes.error.message);
  if (conceptRes.error) return jsonError(conceptRes.error.message);
  if (profileRes.error) return jsonError(profileRes.error.message);
  if (srsRes.error) return jsonError(srsRes.error.message);

  const questions = mergeQuestionsWithSrs(
    (questionRes.data ?? []) as Question[],
    (srsRes.data ?? []) as SRSState[],
  );
  const concepts = (conceptRes.data ?? []) as Concept[];

  // Exam-block due_date takes priority over the user's global exam date.
  // This lets each folder have its own hard deadline that tightens the SRS.
  const effectiveDeadline = deckDeadline ?? profileRes.data?.exam_date ?? null;
  const examDate = effectiveDeadline ? new Date(effectiveDeadline) : null;

  const masteryData = computeAllMastery(concepts, questions);
  const queue = buildQueue(questions, masteryData, concepts, examDate);

  return jsonOk({ queue, examDate: effectiveDeadline } satisfies QueueResponse);
}
