/**
 * GET /api/pdfs/[id]/concepts — fetch all concepts for a processed PDF
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.supabase
    .from('concepts')
    .select('*')
    .eq('pdf_id', params.id)
    .order('importance', { ascending: false })
    .order('name', { ascending: true });

  if (error) return jsonError(error.message);

  return jsonOk({ concepts: data ?? [] });
}
