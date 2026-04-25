'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [joinSlug, setJoinSlug] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    const urlMode = params.get('mode');
    if (join) setJoinSlug(join);
    if (urlMode === 'signup') setMode('signup');
  }, []);

  async function joinAfterAuth(slug: string) {
    await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, { method: 'POST' });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error: authError } = mode === 'login'
      ? await supabaseBrowser.auth.signInWithPassword({ email, password })
      : await supabaseBrowser.auth.signUp({ email, password });

    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    if (mode === 'signup') {
      if (joinSlug) localStorage.setItem('pendingJoin', joinSlug);
      setError('Check your email for a confirmation link.');
      return;
    }

    if (joinSlug) await joinAfterAuth(joinSlug);
    window.location.href = '/app';
  }

  async function signInWithGoogle() {
    if (joinSlug) localStorage.setItem('pendingJoin', joinSlug);
    await supabaseBrowser.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-red-500 tracking-widest">CARDIO</h1>
          <p className="text-gray-500 text-sm mt-1">Medical Board Study Platform</p>
        </div>

        <form onSubmit={submit} className="bg-gray-900 border border-gray-700 rounded-xl p-6 space-y-4">
          <h2 className="text-white font-semibold">{mode === 'login' ? 'Sign In' : 'Create Account'}</h2>

          {joinSlug && (
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
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600"
          />

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white py-2 rounded text-sm font-medium"
          >
            {loading ? '…' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>

          <button
            type="button"
            onClick={signInWithGoogle}
            className="w-full border border-gray-700 hover:border-gray-500 text-gray-300 py-2 rounded text-sm"
          >
            Continue with Google
          </button>

          <p className="text-center text-xs text-gray-600">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
              className="text-red-400 hover:underline"
            >
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
