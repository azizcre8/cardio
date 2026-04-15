/**
 * GET  /api/decks — fetch the full deck tree for the authenticated user
 * POST /api/decks — create a new deck (root or nested)
 */

import { NextRequest } from 'next/server';
import { getDecks, insertDeck, nextDeckPosition } from '@/lib/storage';
import { requireUser } from '@/lib/auth';
import { jsonOk, jsonBadRequest } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const decks = await getDecks(auth.userId);
  return jsonOk(decks);
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return jsonBadRequest('name is required');
  }

  const { name, parent_id = null, is_exam_block = false, due_date = null } = body as {
    name: string;
    parent_id?: string | null;
    is_exam_block?: boolean;
    due_date?: string | null;
  };

  if (is_exam_block && !due_date) {
    return jsonBadRequest('due_date is required for exam blocks');
  }

  const position = await nextDeckPosition(auth.userId, parent_id ?? null);

  const deck = await insertDeck({
    user_id:      auth.userId,
    parent_id:    parent_id ?? null,
    name:         name.trim(),
    is_exam_block,
    due_date:     due_date ?? null,
    position,
  });

  return jsonOk(deck);
}
