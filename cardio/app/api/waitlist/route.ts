import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonOk, parseJsonBody } from '@/lib/api';
import { createWaitlistSubmission } from '@/lib/storage';

type Body = {
  email?: string;
  use_case?: string;
};

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;

  const email = String(parsed.data.email ?? '').trim();
  const useCase = String(parsed.data.use_case ?? '').trim();
  if (!email || !email.includes('@')) return jsonBadRequest('A valid email is required.');
  if (!useCase) return jsonBadRequest('Tell us how you will use Cardio.');

  const submission = await createWaitlistSubmission({
    user_id: auth.userId,
    email,
    use_case: useCase,
  });

  return jsonOk({ submission });
}
