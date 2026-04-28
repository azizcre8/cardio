'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMessage('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setMessage('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    setMessage('');
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      setMessage(error.message);
    } else {
      setDone(true);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0a', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-widest" style={{ color: 'var(--accent)' }}>CARDIO</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>Medical-study question SRS</p>
        </div>

        <div className="rounded-xl p-6 space-y-4" style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}>
          <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>Set New Password</h2>

          {done ? (
            <div className="space-y-4">
              <p className="text-xs px-3 py-2 rounded bg-green-900 text-green-300">
                Password updated. You can now sign in.
              </p>
              <a
                href="/login"
                className="block text-center w-full py-2 rounded text-sm font-medium"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
              >
                Go to Sign In
              </a>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {message && (
                <p className="text-xs px-3 py-2 rounded bg-red-900 text-red-300">{message}</p>
              )}
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full rounded px-3 py-2 text-sm"
                style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
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
                {loading ? '…' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
