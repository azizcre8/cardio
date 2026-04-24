'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function JoinSection({ slug }: { slug: string }) {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabaseBrowser.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
    });
  }, []);

  async function join() {
    setJoining(true);
    setError(null);
    try {
      const res = await fetch(`/api/shared-banks/${encodeURIComponent(slug)}/join`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? 'Failed to join');
      }
      setJoined(true);
      setTimeout(() => { window.location.href = '/app'; }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
    }
  }

  const btnBase: React.CSSProperties = {
    display: 'inline-block', padding: '12px 28px',
    borderRadius: 8, fontSize: 15, fontWeight: 600,
    cursor: 'pointer', border: 'none', fontFamily: 'var(--font-sans)',
    transition: 'opacity 0.15s',
  };

  if (userId === undefined) {
    return <div style={{ height: 48 }} />;
  }

  if (joined) {
    return (
      <div style={{
        padding: '14px 20px', borderRadius: 8,
        background: 'var(--accent-dim)', color: 'var(--accent)',
        fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-sans)',
      }}>
        Added to your library — redirecting…
      </div>
    );
  }

  if (userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          onClick={join}
          disabled={joining}
          style={{ ...btnBase, background: 'var(--accent)', color: '#fff', opacity: joining ? 0.6 : 1 }}
        >
          {joining ? 'Adding…' : 'Add to my library'}
        </button>
        {error && (
          <p style={{ fontSize: 13, color: 'var(--red, #ef4444)', fontFamily: 'var(--font-sans)' }}>{error}</p>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <a
        href={`/login?join=${encodeURIComponent(slug)}&mode=signup`}
        style={{ ...btnBase, background: 'var(--accent)', color: '#fff', textDecoration: 'none', textAlign: 'center' }}
      >
        Create free account to study
      </a>
      <a
        href={`/login?join=${encodeURIComponent(slug)}`}
        style={{
          ...btnBase, background: 'transparent',
          border: '1px solid var(--border)', color: 'var(--text-secondary)',
          textDecoration: 'none', textAlign: 'center',
        }}
      >
        Sign in
      </a>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)', margin: 0 }}>
        Studying shared banks is free. Generating new banks requires a paid plan.
      </p>
    </div>
  );
}
