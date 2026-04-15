/**
 * GET /api/study/queue?pdfId=<uuid>
 * Returns an adaptive study queue for the given PDF, with SRS state merged.
 */

import { NextRequest } from 'next/server';
import { getQuestionsWithSRS, getConcepts, getUserProfile, getExamDeadlineForPdf } from '@/lib/storage';
import { buildQueue, computeAllMastery } from '@/lib/srs';
import type { QueueResponse } from '@/types';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const pdfId = req.nextUrl.searchParams.get('pdfId');
  if (!pdfId) return jsonBadRequest('pdfId required');

  const userId = auth.userId;

  const [questions, concepts, profile, deckDeadline] = await Promise.all([
    getQuestionsWithSRS(pdfId, userId),
    getConcepts(pdfId),
    getUserProfile(userId),
    getExamDeadlineForPdf(pdfId),
  ]);

  // Exam-block due_date takes priority over the user's global exam date.
  // This lets each folder have its own hard deadline that tightens the SRS.
  const effectiveDeadline = deckDeadline ?? profile?.exam_date ?? null;
  const examDate = effectiveDeadline ? new Date(effectiveDeadline) : null;

  const masteryData = computeAllMastery(concepts, questions);
  const queue = buildQueue(questions, masteryData, concepts, examDate);

  return jsonOk({ queue, examDate: effectiveDeadline } satisfies QueueResponse);
}
