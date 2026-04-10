import { createClient } from '@supabase/supabase-js';
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ─── Browser client (anon key, safe for client components) ───────────────────

export const supabaseBrowser = createClient(supabaseUrl, supabaseAnonKey);

// ─── Server Component client (uses session cookie) ───────────────────────────
// Call inside a Server Component or Route Handler — not at module level.

export function supabaseServer() {
  const cookieStore = cookies();
  return createServerComponentClient({ cookies: () => cookieStore });
}

// ─── Admin client (service role — NEVER expose to browser) ───────────────────
// Use only in API routes and server-side pipeline code.

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
