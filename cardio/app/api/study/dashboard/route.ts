/**
 * GET /api/study/dashboard?scope=library|deck|pdf&id=<uuid>
 * Returns Anki-style study counts and attempt accuracy for the requested scope.
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import {
  getPdfDisplayName,
  getQuestionBasicsForScopedPdfs,
  getScopedPdfsForUser,
  getSrsForScopedPdfs,
  parseStudyScope,
} from '@/lib/study-scope';
import { supabaseAdmin } from '@/lib/supabase';
import type {
  LibraryDashboardChapter,
  LibraryDashboardResponse,
  LibraryDashboardSummary,
} from '@/types';

export const dynamic = 'force-dynamic';

type AttemptBasic = {
  question_id: string;
  pdf_id: string;
  is_correct: boolean;
};

function accuracy(correct: number, total: number) {
  return total > 0 ? Math.round((correct / total) * 100) : null;
}

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const scopeParam = req.nextUrl.searchParams.get('scope');
  const id = req.nextUrl.searchParams.get('id')
    ?? req.nextUrl.searchParams.get('pdfId')
    ?? req.nextUrl.searchParams.get('deckId');
  const scope = parseStudyScope(scopeParam, id);
  if (!scope) return jsonBadRequest('Invalid dashboard scope');

  const pdfs = await getScopedPdfsForUser(auth.userId, scope);
  if (!pdfs) return jsonNotFound('Scope not found');

  const pdfIds = pdfs.map(pdf => pdf.id);
  const [questions, srsRows, attempts] = await Promise.all([
    getQuestionBasicsForScopedPdfs(pdfs),
    getSrsForScopedPdfs(auth.userId, pdfs),
    pdfIds.length > 0
      ? supabaseAdmin
        .from('question_attempts')
        .select('question_id, pdf_id, is_correct')
        .eq('user_id', auth.userId)
        .in('pdf_id', pdfIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (attempts.error) return jsonError(attempts.error.message);

  const now = Date.now();
  const srsByQuestionId = new Map(srsRows.map(row => [row.question_id, row]));
  const visibleQuestionIds = new Set(questions.map(question => question.id));
  const questionsByPdfId = new Map<string, typeof questions>();
  const attemptRows = ((attempts.data ?? []) as AttemptBasic[])
    .filter(attempt => visibleQuestionIds.has(attempt.question_id));
  const attemptQuestionIds = new Set(attemptRows.map(attempt => attempt.question_id));

  for (const question of questions) {
    const list = questionsByPdfId.get(question.pdf_id) ?? [];
    list.push(question);
    questionsByPdfId.set(question.pdf_id, list);
  }

  function countDueAndNew(pdfQuestions: typeof questions) {
    let dueCount = 0;
    let newCount = 0;
    for (const question of pdfQuestions) {
      const srs = srsByQuestionId.get(question.id);
      if (!srs || srs.times_reviewed === 0) {
        newCount += 1;
        continue;
      }
      if (new Date(srs.next_review).getTime() <= now) dueCount += 1;
    }
    return { dueCount, newCount };
  }

  const chapters: LibraryDashboardChapter[] = pdfs.map(pdf => {
    const pdfQuestions = questionsByPdfId.get(pdf.id) ?? [];
    const pdfQuestionIds = new Set(pdfQuestions.map(question => question.id));
    const pdfAttempts = attemptRows.filter(attempt => attempt.pdf_id === pdf.id);
    const pdfAttemptedQuestionIds = new Set(
      pdfAttempts
        .filter(attempt => pdfQuestionIds.has(attempt.question_id))
        .map(attempt => attempt.question_id),
    );
    const correctAttempts = pdfAttempts.filter(attempt => attempt.is_correct).length;
    const { dueCount, newCount } = countDueAndNew(pdfQuestions);

    return {
      pdfId: pdf.id,
      deckId: pdf.deck_id,
      title: getPdfDisplayName(pdf),
      questionCount: pdfQuestions.length,
      attemptedQuestions: pdfAttemptedQuestionIds.size,
      totalAttempts: pdfAttempts.length,
      correctAttempts,
      accuracy: accuracy(correctAttempts, pdfAttempts.length),
      dueCount,
      newCount,
      processed: Boolean(pdf.processed_at),
    };
  });

  const correctAttempts = attemptRows.filter(attempt => attempt.is_correct).length;
  const dueAndNew = countDueAndNew(questions);
  const summary: LibraryDashboardSummary = {
    totalQuestions: questions.length,
    attemptedQuestions: attemptQuestionIds.size,
    totalAttempts: attemptRows.length,
    correctAttempts,
    accuracy: accuracy(correctAttempts, attemptRows.length),
    dueCount: dueAndNew.dueCount,
    newCount: dueAndNew.newCount,
    readySourceCount: pdfs.filter(pdf => !!pdf.processed_at).length,
    totalSourceCount: pdfs.length,
  };

  return jsonOk({ summary, chapters } satisfies LibraryDashboardResponse);
}
