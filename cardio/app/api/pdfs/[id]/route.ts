/**
 * DELETE /api/pdfs/[id] — delete a PDF (cascades to chunks, concepts, questions, srs_state)
 */

import { NextRequest, NextResponse } from 'next/server';
import { deletePDF } from '@/lib/storage';
import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  await deletePDF(params.id);
  return jsonOk({ deleted: params.id });
}
