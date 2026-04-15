/**
 * PATCH  /api/pdfs/[id] — update display_name, deck_id, or position
 * DELETE /api/pdfs/[id] — delete a PDF (cascades to chunks, concepts, questions, srs_state)
 */

import { NextRequest } from 'next/server';
import { deletePDF, updatePDF } from '@/lib/storage';
import { requireUser } from '@/lib/auth';
import { jsonOk, jsonBadRequest } from '@/lib/api';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonBadRequest('invalid body');

  const patch: Record<string, unknown> = {};
  if ('display_name' in body) patch.display_name = body.display_name ?? null;
  if ('deck_id' in body)      patch.deck_id      = body.deck_id      ?? null;
  if ('position' in body)     patch.position     = body.position;

  if (Object.keys(patch).length === 0) return jsonBadRequest('no fields to update');

  await updatePDF(params.id, patch as Parameters<typeof updatePDF>[1]);
  return jsonOk({ updated: params.id });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  await deletePDF(params.id);
  return jsonOk({ deleted: params.id });
}
