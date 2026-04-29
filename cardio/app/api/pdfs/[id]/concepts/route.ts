/**
 * GET /api/pdfs/[id]/concepts — fetch all concepts for a processed PDF
 */

import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { getAccessiblePdfForUser } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const access = await getAccessiblePdfForUser(params.id, auth.userId);
  if (!access) return jsonNotFound('PDF not found');

  const { data, error } = await supabaseAdmin
    .from('concepts')
    .select('*')
    .eq('pdf_id', params.id)
    .eq('user_id', access.pdf.user_id)
    .order('importance', { ascending: false })
    .order('name', { ascending: true });

  if (error) return jsonError(error.message);

  return jsonOk({ concepts: data ?? [] });
}
