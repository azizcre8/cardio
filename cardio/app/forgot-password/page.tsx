'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    setSuccess(false);
    setLoading(true);

    const { error } = await supabaseBrowser.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    setLoading(false);
    if (error) {
      setMessage(error.message);
    } else {
      setSuccess(true);
      setMessage('Check your email for a password reset link.');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0a', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-widest" style={{ color: 'var(--accent)' }}>CARDIO</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>Medical-study question SRS</p>
        </div>

        <form onSubmit={submit} className="rounded-xl p-6 space-y-4" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Reset Password</h2>

          {message && (
            <p className={`text-xs px-3 py-2 rounded ${success ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
              {message}
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

          <button
            type="submit"
            disabled={loading}
            className="w-full disabled:opacity-50 py-2 rounded text-sm font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {loading ? '...' : 'Send Reset Link'}
          </button>

          <p className="text-center text-xs" style={{ color: 'var(--text-dim)' }}>
            <a
              href="/login"
              className="hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              Back to sign in
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
