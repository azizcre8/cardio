import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getPDF } from '@/lib/storage';

export const maxDuration = 30;
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { pdfId } = await req.json() as { pdfId: string };
  const pdf = await getPDF(pdfId, auth.userId);
  if (!pdf) return new Response('PDF not found', { status: 404 });
  const doneEvent = { phase: 7, message: 'Done', pct: 100, data: { pdfId, questionCount: pdf.question_count ?? 0 } };
  return new Response('data: ' + JSON.stringify(doneEvent) + '\n\n', {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
