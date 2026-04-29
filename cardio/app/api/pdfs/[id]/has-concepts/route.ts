import { requireUser } from '@/lib/auth';
import { jsonNotFound, jsonOk } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { checkPdfHasConcepts } from '@/lib/storage';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const access = await getAccessiblePdfForUser(params.id, auth.userId);
  if (!access) return jsonNotFound('PDF not found');

  const hasConcepts = await checkPdfHasConcepts(params.id);
  return jsonOk({ hasConcepts });
}
