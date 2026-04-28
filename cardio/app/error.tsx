'use client';

import Link from 'next/link';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ minHeight: '100vh', background: '#0a0a0a', color: '#E6EDF3', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <p style={{ color: '#F85149', fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Error</p>
        <h1 style={{ fontSize: 38, fontWeight: 500, margin: '8px 0 10px' }}>Something went wrong</h1>
        <p style={{ color: '#8B949E', lineHeight: 1.6, marginBottom: 24 }}>Try again or return to the app.</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={reset} style={buttonStyle}>Try again</button>
          <Link href="/app" style={buttonStyle}>Open app</Link>
        </div>
      </div>
    </main>
  );
}

const buttonStyle = {
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  background: 'transparent',
  color: '#E6EDF3',
  padding: '9px 14px',
  textDecoration: 'none',
  cursor: 'pointer',
} as const;
