/**
 * GET /api/study/queue?pdfId=<uuid>
 * Returns an adaptive study queue for the given PDF, with SRS state merged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { getQuestionsWithSRS, getConcepts, getUserProfile } from '@/lib/storage';
import { buildQueue, computeAllMastery } from '@/lib/srs';
import type { QueueResponse } from '@/types';

export async function GET(req: NextRequest) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pdfId = req.nextUrl.searchParams.get('pdfId');
  if (!pdfId) return NextResponse.json({ error: 'pdfId required' }, { status: 400 });

  const userId = session.user.id;

  const [questions, concepts, profile] = await Promise.all([
    getQuestionsWithSRS(pdfId, userId),
    getConcepts(pdfId),
    getUserProfile(userId),
  ]);

  const examDate = profile?.exam_date ? new Date(profile.exam_date) : null;
  const masteryData = computeAllMastery(concepts, questions);
  const queue = buildQueue(questions, masteryData, concepts, examDate);

  return NextResponse.json({ queue, examDate: profile?.exam_date ?? null } satisfies QueueResponse);
}
