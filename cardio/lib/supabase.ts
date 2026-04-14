import { createClient } from '@supabase/supabase-js';
import { createRouteHandlerClient, createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { env } from '@/lib/env';
import { cookies } from 'next/headers';

// ─── Route Handler client ────────────────────────────────────────────────────
// Use inside API Route Handlers (app/api/**/route.ts)
export function supabaseServer() {
  return createRouteHandlerClient({ cookies });
}

// ─── Server Component client ─────────────────────────────────────────────────
// Use inside Server Components (not Route Handlers)
export function supabaseServerComponent() {
  const cookieStore = cookies();
  return createServerComponentClient({ cookies: () => cookieStore });
}

// ─── Admin client (Now hidden from the browser) ─────────────────────────────
// We only initialize this if we are NOT in a browser to prevent crashes
export const supabaseAdmin = typeof window === 'undefined' 
  ? createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null as any;
