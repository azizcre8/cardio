import { supabaseServer } from '@/lib/supabase';
import { jsonUnauthorized } from '@/lib/api';

export async function requireUser() {
  const supabase = supabaseServer();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return {
      ok: false as const,
      response: jsonUnauthorized(),
    };
  }

  return {
    ok: true as const,
    supabase,
    session,
    userId: session.user.id,
  };
}
