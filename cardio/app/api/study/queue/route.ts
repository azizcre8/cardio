/**
 * GET /api/study/queue?pdfId=<uuid>
 * Returns an adaptive study queue for the given PDF, with SRS state merged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getQuestionsWithSRS, getConcepts, getUserProfile } from '@/lib/storage';
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

  const [questions, concepts, profile] = await Promise.all([
    getQuestionsWithSRS(pdfId, userId),
    getConcepts(pdfId),
    getUserProfile(userId),
  ]);

  const examDate = profile?.exam_date ? new Date(profile.exam_date) : null;
  const masteryData = computeAllMastery(concepts, questions);
  const queue = buildQueue(questions, masteryData, concepts, examDate);

  return jsonOk({ queue, examDate: profile?.exam_date ?? null } satisfies QueueResponse);
}
