/**
 * GET /api/pdfs — list all PDFs for the authenticated user
 */

import { getPDFs } from '@/lib/storage';
import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const pdfs = await getPDFs(auth.userId);
  return jsonOk(pdfs);
}
