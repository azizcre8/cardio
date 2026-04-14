import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

// ─── Browser client ─────────────────────────────────────────────────────────
// This is safe to use in any "use client" file
export const supabaseBrowser = (() => {
  if (typeof window === 'undefined') return null as any;
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  return createClientComponentClient();
})();

// ─── Route Handler client ────────────────────────────────────────────────────
// Use inside API Route Handlers (app/api/**/route.ts)
export function supabaseServer() {
  const { createRouteHandlerClient } = require('@supabase/auth-helpers-nextjs');
  const { cookies } = require('next/headers');
  return createRouteHandlerClient({ cookies });
}

// ─── Server Component client ─────────────────────────────────────────────────
// Use inside Server Components (not Route Handlers)
export function supabaseServerComponent() {
  const { createServerComponentClient } = require('@supabase/auth-helpers-nextjs');
  const { cookies } = require('next/headers');
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
