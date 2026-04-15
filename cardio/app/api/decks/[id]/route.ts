/**
 * PATCH  /api/decks/[id] — rename, reparent, toggle exam block, or update due_date
 * DELETE /api/decks/[id] — delete deck (children become root; PDFs become uncategorized)
 */

import { NextRequest } from 'next/server';
import { updateDeck, deleteDeck } from '@/lib/storage';
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

  if ('name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim()) return jsonBadRequest('name must be a non-empty string');
    patch.name = body.name.trim();
  }
  if ('parent_id' in body)     patch.parent_id     = body.parent_id     ?? null;
  if ('position' in body)      patch.position      = body.position;
  if ('is_exam_block' in body) patch.is_exam_block = !!body.is_exam_block;
  if ('due_date' in body)      patch.due_date      = body.due_date      ?? null;

  if (Object.keys(patch).length === 0) return jsonBadRequest('no fields to update');

  // Exam block must have a due_date
  if (patch.is_exam_block === true && !patch.due_date) {
    return jsonBadRequest('due_date is required when is_exam_block is true');
  }

  await updateDeck(params.id, patch);
  return jsonOk({ updated: params.id });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  await deleteDeck(params.id);
  return jsonOk({ deleted: params.id });
}
