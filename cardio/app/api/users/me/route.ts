import { NextRequest } from 'next/server';
import { requireUser } from '@/lib/auth';
import { jsonBadRequest, jsonOk } from '@/lib/api';
import { getUserProfile, updateUserProfile } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const profile = await getUserProfile(auth.userId);
  return jsonOk({
    id: auth.userId,
    email: profile?.email ?? auth.session.user.email ?? null,
    exam_date: profile?.exam_date ?? null,
  });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || (!('exam_date' in body) && !('examDate' in body))) {
    return jsonBadRequest('exam_date is required');
  }

  const examDate = body.exam_date ?? body.examDate ?? null;
  if (examDate !== null && typeof examDate !== 'string') {
    return jsonBadRequest('exam_date must be a string or null');
  }

  await updateUserProfile(auth.userId, { exam_date: examDate });

  return jsonOk({
    updated: true,
    exam_date: examDate,
  });
}
