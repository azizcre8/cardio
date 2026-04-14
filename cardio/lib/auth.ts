import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';

export async function requireUser() {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    ok: true as const,
    supabase,
    session,
    userId: session.user.id,
  };
}
