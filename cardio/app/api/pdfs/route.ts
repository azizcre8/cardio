/**
 * GET /api/pdfs — list all PDFs for the authenticated user
 */

import { NextResponse } from 'next/server';
import { getPDFs } from '@/lib/storage';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const pdfs = await getPDFs(auth.userId);
  return NextResponse.json(pdfs);
}
