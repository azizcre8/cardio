/**
 * GET /api/pdfs — list all PDFs for the authenticated user
 */

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { getPDFs } from '@/lib/storage';

export async function GET() {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const pdfs = await getPDFs(session.user.id);
  return NextResponse.json(pdfs);
}
