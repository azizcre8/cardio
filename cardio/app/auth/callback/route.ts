import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { addSharedBankMember, getSharedBankBySlug } from '@/lib/storage';
import { getJoinSlugFromAuthNext, sanitizeAuthNextPath } from '@/lib/join-intent';

async function joinSharedBankFromIntent(slug: string, userId: string) {
  const bank = await getSharedBankBySlug(slug);
  if (!bank || !bank.is_active || bank.owner_user_id === userId) return;
  await addSharedBankMember(bank.id, userId, 'member');
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const origin = req.nextUrl.origin;
  const nextPath = sanitizeAuthNextPath(req.nextUrl.searchParams.get('next'));

  if (code) {
    const supabase = createRouteHandlerClient({ cookies });
    const { data } = await supabase.auth.exchangeCodeForSession(code);
    let userId = data.user?.id ?? data.session?.user.id ?? null;

    if (!userId) {
      const { data: userData } = await supabase.auth.getUser();
      userId = userData.user?.id ?? null;
    }

    const joinSlug = getJoinSlugFromAuthNext(nextPath);
    if (joinSlug && userId) {
      try {
        await joinSharedBankFromIntent(joinSlug, userId);
      } catch (error) {
        console.error('auth callback join intent failed', error);
      }
    }
  }

  return NextResponse.redirect(new URL(nextPath, origin));
}
