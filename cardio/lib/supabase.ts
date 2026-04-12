import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ─── Browser client ─────────────────────────────────────────────────────────
// This is safe to use in any "use client" file
export const supabaseBrowser = (() => {
  if (typeof window === 'undefined') return null as any;
  const { createClientComponentClient } = require('@supabase/auth-helpers-nextjs');
  return createClientComponentClient();
})();

// ─── Server Component client ────────────────────────────────────────────────
// Call this inside your API routes or Server Components
export function supabaseServer() {
  const { createServerComponentClient } = require('@supabase/auth-helpers-nextjs');
  const { cookies } = require('next/headers');
  const cookieStore = cookies();
  return createServerComponentClient({ cookies: () => cookieStore });
}

// ─── Admin client (Now hidden from the browser) ─────────────────────────────
// We only initialize this if we are NOT in a browser to prevent crashes
export const supabaseAdmin = typeof window === 'undefined' 
  ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null as any;
