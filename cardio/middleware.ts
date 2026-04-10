import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createMiddlewareClient({ req, res });

  const { data: { session } } = await supabase.auth.getSession();

  const { pathname } = req.nextUrl;

  // Protect /app routes — redirect unauthenticated users to login
  if (pathname.startsWith('/app') && !session) {
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect logged-in users away from login page
  if (pathname === '/login' && session) {
    const appUrl = new URL('/app', req.url);
    return NextResponse.redirect(appUrl);
  }

  return res;
}

export const config = {
  matcher: ['/app/:path*', '/login'],
};
