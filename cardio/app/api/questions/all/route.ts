import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';
import { getAllQuestionsForUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const questions = await getAllQuestionsForUser(auth.userId);
  return jsonOk({ questions });
}
