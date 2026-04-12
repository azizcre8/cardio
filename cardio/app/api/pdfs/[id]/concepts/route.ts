/**
 * GET /api/pdfs/[id]/concepts — fetch all concepts for a processed PDF
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { getConcepts } from '@/lib/storage';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const concepts = await getConcepts(params.id);
  const userConcepts = concepts.filter(c => c.user_id === session.user.id);

  return NextResponse.json({ concepts: userConcepts });
}
