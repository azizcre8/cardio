/**
 * GET /api/shared-banks/[slug]/questions - fetch all questions for a shared bank.
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk, jsonUnauthorized } from '@/lib/api';
import { getSharedBankBySlug } from '@/lib/storage';
import { getSharedBankSources } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import { QUIZ_QUESTION_SELECT, flattenQuizQuestion, shuffleInPlace } from '@/lib/quiz-questions';

export const dynamic = 'force-dynamic';

async function canStudySharedBank(bankId: string, ownerUserId: string, userId: string, visibility: string) {
  if (ownerUserId === userId || visibility === 'public') return true;

  const { data, error } = await supabaseAdmin
    .from('shared_bank_members')
    .select('id')
    .eq('shared_bank_id', bankId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`canStudySharedBank: ${error.message}`);
  return Boolean(data);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const bank = await getSharedBankBySlug(params.slug);
  if (!bank || !bank.is_active) return jsonNotFound('Shared bank not found');

  const canStudy = await canStudySharedBank(bank.id, bank.owner_user_id, auth.userId, bank.visibility);
  if (!canStudy) return jsonUnauthorized('Join this shared bank before starting a quiz.');

  const bankWithSources = await getSharedBankSources(supabaseAdmin, bank);
  const sourcePdfIds = bankWithSources.source_pdfs.map(pdf => pdf.id);
  if (sourcePdfIds.length === 0) {
    return jsonOk({
      questions: [],
      bank: {
        slug: bank.slug,
        title: bank.title,
        sourceCount: 0,
        questionCount: 0,
      },
    });
  }

  const { data, error } = await supabaseAdmin
    .from('questions')
    .select(QUIZ_QUESTION_SELECT)
    .eq('user_id', bank.owner_user_id)
    .in('pdf_id', sourcePdfIds)
    .eq('flagged', false);

  if (error) return jsonError(error.message);

  const questions = shuffleInPlace((data ?? []).map((q: Record<string, unknown>) => flattenQuizQuestion(q)));

  return jsonOk({
    questions,
    bank: {
      slug: bank.slug,
      title: bank.title,
      sourceCount: sourcePdfIds.length,
      questionCount: questions.length,
    },
  });
}
