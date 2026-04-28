import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getPDF } from '@/lib/storage';
import type { ProcessEvent } from '@/types';

export const maxDuration = 30;
export const runtime = 'nodejs';

type GeneratePayload = {
  pdfId?: unknown;
  batchOffset?: unknown;
  batchSize?: unknown;
  isFinal?: unknown;
};

function encodeEvent(ev: ProcessEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  let body: GeneratePayload;
  try {
    body = await req.json() as GeneratePayload;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const pdfId = typeof body.pdfId === 'string' ? body.pdfId.trim() : '';
  if (!pdfId) return new Response('pdfId is required', { status: 400 });

  const batchOffset = body.batchOffset ?? 0;
  const batchSize = body.batchSize ?? 1;
  const isFinal = body.isFinal ?? true;
  if (!isNonNegativeInteger(batchOffset)) return new Response('batchOffset must be a non-negative integer', { status: 400 });
  if (!isNonNegativeInteger(batchSize) || batchSize < 1) return new Response('batchSize must be a positive integer', { status: 400 });
  if (typeof isFinal !== 'boolean') return new Response('isFinal must be a boolean', { status: 400 });

  const pdf = await getPDF(pdfId, auth.userId);
  if (!pdf) return new Response('PDF not found', { status: 404 });

  if (!pdf.processed_at) {
    const pendingEvent: ProcessEvent = {
      phase: 6,
      message: 'Question generation is still finalising. Please retry shortly.',
      pct: 95,
      data: { pdfId, batchDone: true },
    };
    return new Response(encodeEvent(pendingEvent), {
      status: 409,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }

  const doneEvent: ProcessEvent = {
    phase: 7,
    message: 'Done',
    pct: 100,
    data: {
      pdfId,
      questionCount: pdf.question_count ?? 0,
      questionsGenerated: pdf.question_count ?? 0,
    },
  };
  return new Response(encodeEvent(doneEvent), {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}
