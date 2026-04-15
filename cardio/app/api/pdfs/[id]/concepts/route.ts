/**
 * GET /api/pdfs/[id]/concepts — fetch all concepts for a processed PDF
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConcepts } from '@/lib/storage';
import { requireUser } from '@/lib/auth';
import { jsonOk } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const concepts = await getConcepts(params.id);
  const userConcepts = concepts.filter(c => c.user_id === auth.userId);

  return jsonOk({ concepts: userConcepts });
}
