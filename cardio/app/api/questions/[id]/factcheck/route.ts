import { requireUser } from '@/lib/auth';
import { jsonNotFound, jsonOk } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { factCheckQuestionForUser, getQuestionForUser } from '@/lib/storage';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: question } = await supabaseAdmin
    .from('questions')
    .select('pdf_id, user_id')
    .eq('id', params.id)
    .maybeSingle();

  if (!question) return jsonNotFound('Question not found.');

  const access = await getAccessiblePdfForUser(question.pdf_id as string, auth.userId);
  if (!access) return jsonNotFound('Question not found.');

  const result = access.access_scope === 'owned'
    ? await factCheckQuestionForUser(params.id, auth.userId)
    : await factCheckSharedQuestion(params.id, access.pdf.user_id);
  if (!result) return jsonNotFound('Question not found.');

  return jsonOk(result);
}

async function factCheckSharedQuestion(questionId: string, ownerUserId: string) {
  const question = await getQuestionForUser(questionId, ownerUserId);
  if (!question) return null;
  const evidence = [
    question.source_quote,
    question.chunk_id,
    question.evidence_match_type && question.evidence_match_type !== 'none' ? question.evidence_match_type : '',
  ].filter(Boolean).join(' ').trim();

  return {
    medicallyAccurate: !question.flagged && !((question.option_set_flags ?? []).length > 0),
    sourcedFromText: evidence.length > 0 && question.source_quote !== 'UNGROUNDED',
  };
}
