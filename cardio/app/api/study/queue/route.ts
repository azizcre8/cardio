/**
 * GET /api/study/queue?pdfId=<uuid>
 * Returns an adaptive study queue for the given PDF, with SRS state merged.
 */

import { NextRequest } from 'next/server';
import { getDecks, getExamDeadlineForPdf } from '@/lib/storage';
import { buildQueue, computeAllMastery } from '@/lib/srs';
import type { Deck, QueueResponse } from '@/types';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import {
  getConceptsForScopedPdfs,
  getQuestionsForScopedPdfs,
  getScopedPdfsForUser,
  getSrsForScopedPdfs,
  mergeQuestionsWithSrs,
  parseStudyScope,
  type StudyScope,
} from '@/lib/study-scope';

export const dynamic = 'force-dynamic';

function scopeFromRequest(req: NextRequest): StudyScope | null {
  const pdfId = req.nextUrl.searchParams.get('pdfId');
  if (pdfId) return { type: 'pdf', id: pdfId };

  const scopeParam = req.nextUrl.searchParams.get('scope');
  if (!scopeParam) return null;

  const id = req.nextUrl.searchParams.get('id') ?? req.nextUrl.searchParams.get('deckId');
  return parseStudyScope(scopeParam, id);
}

function deckDeadline(decks: Deck[], deckId: string): string | null {
  const byId = new Map(decks.map(deck => [deck.id, deck]));
  let current = byId.get(deckId) ?? null;
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.is_exam_block && current.due_date) return current.due_date;
    current = current.parent_id ? byId.get(current.parent_id) ?? null : null;
  }

  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const scope = scopeFromRequest(req);
  if (!scope) return jsonBadRequest('pdfId or scope query param required');

  const userId = auth.userId;
  const pdfs = await getScopedPdfsForUser(userId, scope);
  if (!pdfs) return jsonNotFound('Study scope not found');

  const [questionRows, conceptRows, profileRes, srsRows, scopedDeadline] = await Promise.all([
    getQuestionsForScopedPdfs(pdfs),
    getConceptsForScopedPdfs(pdfs),
    auth.supabase.from('users').select('exam_date').eq('id', userId).single(),
    getSrsForScopedPdfs(userId, pdfs),
    scope.type === 'pdf'
      ? getExamDeadlineForPdf(scope.id)
      : scope.type === 'deck'
      ? getDecks(userId).then(decks => deckDeadline(decks, scope.id))
      : Promise.resolve(null),
  ]);

  if (profileRes.error) return jsonError(profileRes.error.message);

  const questions = mergeQuestionsWithSrs(
    questionRows,
    srsRows,
  );

  // Exam-block due_date takes priority over the user's global exam date.
  // This lets each folder have its own hard deadline that tightens the SRS.
  const effectiveDeadline = scopedDeadline ?? profileRes.data?.exam_date ?? null;
  const examDate = effectiveDeadline ? new Date(effectiveDeadline) : null;

  const masteryData = computeAllMastery(conceptRows, questions);
  const queue = buildQueue(questions, masteryData, conceptRows, examDate);

  return jsonOk({ queue, examDate: effectiveDeadline } satisfies QueueResponse);
}
