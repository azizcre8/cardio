/**
 * DELETE /api/pdfs/[id] — delete a PDF (cascades to chunks, concepts, questions, srs_state)
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { deletePDF } from '@/lib/storage';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await deletePDF(params.id);
  return NextResponse.json({ deleted: params.id });
}
