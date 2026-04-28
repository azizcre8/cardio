import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonOk, parseJsonBody } from '@/lib/api';
import { getFlaggedQuestionsForUser, unflagQuestionForUser } from '@/lib/storage';

type PatchBody = {
  questionId?: string;
};

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const questions = await getFlaggedQuestionsForUser(auth.userId);
  return jsonOk({ questions });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<PatchBody>(req);
  if (!parsed.ok) return parsed.response;

  const questionId = String(parsed.data.questionId ?? '').trim();
  if (!questionId) return jsonBadRequest('questionId is required.');

  await unflagQuestionForUser(questionId, auth.userId);
  return jsonOk({ updated: true });
}
