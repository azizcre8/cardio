import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';
import { checkPdfHasConcepts } from '@/lib/storage';

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const hasConcepts = await checkPdfHasConcepts(params.id);
  return jsonOk({ hasConcepts });
}
