import { requireUser } from '@/lib/auth';
import { jsonNotFound, jsonOk } from '@/lib/api';
import { factCheckQuestionForUser } from '@/lib/storage';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const result = await factCheckQuestionForUser(params.id, auth.userId);
  if (!result) return jsonNotFound('Question not found.');

  return jsonOk(result);
}
