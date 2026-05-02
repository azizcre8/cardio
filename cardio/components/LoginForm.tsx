'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import {
  buildAuthCallbackUrl,
  buildJoinedAppPath,
  buildSharedBankQuizPath,
  sanitizeAuthNextPath,
} from '@/lib/join-intent';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login');
  const [joinSlug, setJoinSlug] = useState<string | null>(null);
  const [startMixedQuiz, setStartMixedQuiz] = useState(false);
  const [nextPath, setNextPath] = useState('/app');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    const urlMode = params.get('mode');
    if (join) setJoinSlug(join);
    setNextPath(sanitizeAuthNextPath(params.get('next')));
    setStartMixedQuiz(params.get('start') === 'mixed');
    if (urlMode === 'signup') setMode('signup');
  }, []);

  async function joinAfterAuth(slug: string) {
    const res = await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, { method: 'POST' });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) {
      throw new Error(data?.error ?? 'Failed to join shared question bank.');
    }
  }

  function joinedRedirect(slug: string) {
    return startMixedQuiz ? buildSharedBankQuizPath(slug) : buildJoinedAppPath(slug);
  }

  function authCallbackRedirect(slug: string | null) {
    return buildAuthCallbackUrl(
      window.location.origin,
      nextPath.startsWith('/s/') ? nextPath :
      slug ? joinedRedirect(slug) : '/app',
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (mode === 'forgot') {
      const { error: authError } = await supabaseBrowser.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      setLoading(false);
      if (authError) {
        setError(authError.message);
      } else {
        setError('Check your email for a password reset link.');
      }
      return;
    }

    const signUpOptions = joinSlug || nextPath.startsWith('/s/') ? {
      emailRedirectTo: authCallbackRedirect(joinSlug),
      ...(joinSlug ? { data: { join_slug: joinSlug } } : {}),
    } : undefined;

    const { data: authData, error: authError } = mode === 'login'
      ? await supabaseBrowser.auth.signInWithPassword({ email, password })
      : await supabaseBrowser.auth.signUp({
        email,
        password,
        options: signUpOptions,
      });

    if (authError) {
      setLoading(false);
      setError(authError.message);
      return;
    }

    if (mode === 'signup') {
      if (authData.session) {
        if (nextPath.startsWith('/s/')) {
          window.location.href = nextPath;
          return;
        }
        try {
          if (joinSlug) await joinAfterAuth(joinSlug);
          window.location.href = joinSlug ? joinedRedirect(joinSlug) : '/app';
        } catch (err) {
          setLoading(false);
          setError(err instanceof Error ? err.message : 'Failed to join shared question bank.');
        }
        return;
      }
      setLoading(false);
      setError(joinSlug
        ? 'Check your email for a confirmation link. It will finish adding the shared question bank.'
        : 'Check your email for a confirmation link.');
      return;
    }

    try {
      if (nextPath.startsWith('/s/')) {
        window.location.href = nextPath;
        return;
      }
      if (joinSlug) await joinAfterAuth(joinSlug);
      window.location.href = joinSlug ? joinedRedirect(joinSlug) : '/app';
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Failed to join shared question bank.');
    }
  }

  async function signInWithGoogle() {
    await supabaseBrowser.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: authCallbackRedirect(joinSlug) },
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0a', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-widest" style={{ color: 'var(--accent)' }}>CARDIO</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>Medical-study question SRS</p>
        </div>

        <form onSubmit={submit} className="rounded-xl p-6 space-y-4" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
            {mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Reset Password'}
          </h2>

          {joinSlug && mode !== 'forgot' && (
            <p className="text-xs px-3 py-2 rounded bg-teal-900 text-teal-300">
              You&apos;ll be added to the shared question bank after signing in.
            </p>
          )}

          {error && (
            <p className={`text-xs px-3 py-2 rounded ${error.includes('Check your email') ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
              {error}
            </p>
          )}

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            className="w-full rounded px-3 py-2 text-sm"
            style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          />

          {mode !== 'forgot' && (
            <div className="space-y-1">
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full rounded px-3 py-2 text-sm"
                style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              {mode === 'login' && (
                <div className="text-right">
                  <a
                    href="/forgot-password"
                    className="text-xs hover:underline"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Forgot password?
                  </a>
                </div>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full disabled:opacity-50 py-2 rounded text-sm font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {loading ? '…' : mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Send Reset Link'}
          </button>

          {mode !== 'forgot' && (
            <button
              type="button"
              onClick={signInWithGoogle}
              className="w-full py-2 rounded text-sm"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              Continue with Google
            </button>
          )}

          <p className="text-center text-xs" style={{ color: 'var(--text-dim)' }}>
            {mode === 'forgot' ? (
              <>
                Remember it?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); }}
                  className="hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Back to sign in
                </button>
              </>
            ) : mode === 'login' ? (
              <>
                Don&apos;t have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('signup'); setError(''); }}
                  className="hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); }}
                  className="hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
