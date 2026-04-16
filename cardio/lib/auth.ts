import { supabaseServer } from '@/lib/supabase';
import { jsonUnauthorized } from '@/lib/api';
import { supabaseAdmin } from '@/lib/supabase';
import { DEV_LOCAL_USER_EMAIL, isDevAuthBypassEnabled } from '@/lib/dev-auth';

async function getOrCreateDevUser() {
  const existing = await supabaseAdmin
    .from('users')
    .select('id, email')
    .eq('email', DEV_LOCAL_USER_EMAIL)
    .maybeSingle();

  if (existing.data?.id) {
    return {
      id: existing.data.id as string,
      email: (existing.data.email as string | null) ?? DEV_LOCAL_USER_EMAIL,
    };
  }

  const fallback = await supabaseAdmin
    .from('users')
    .select('id, email')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!fallback.data?.id) {
    throw new Error('No local app user exists yet. Sign in once through /login to seed a real user, then localhost dev bypass will keep working.');
  }

  return {
    id: fallback.data.id as string,
    email: (fallback.data.email as string | null) ?? DEV_LOCAL_USER_EMAIL,
  };
}

export async function requireUser() {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session && !isDevAuthBypassEnabled()) {
    return {
      ok: false as const,
      response: jsonUnauthorized(),
    };
  }

  if (!session) {
    const devUser = await getOrCreateDevUser();

    return {
      ok: true as const,
      supabase: supabaseAdmin,
      session: {
        user: {
          id: devUser.id,
          email: devUser.email,
        },
      } as typeof session,
      userId: devUser.id,
    };
  }

  return {
    ok: true as const,
    supabase,
    session,
    userId: session.user.id,
  };
}
