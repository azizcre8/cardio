import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', background: '#0a0a0a', color: '#E6EDF3', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <p style={{ color: '#14C8D8', fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase' }}>404</p>
        <h1 style={{ fontSize: 42, fontWeight: 500, margin: '8px 0 10px' }}>Page not found</h1>
        <p style={{ color: '#8B949E', lineHeight: 1.6, marginBottom: 24 }}>This Cardio page does not exist or moved.</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <Link href="/" style={linkStyle}>Home</Link>
          <Link href="/app" style={linkStyle}>Open app</Link>
        </div>
      </div>
    </main>
  );
}

const linkStyle = {
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#E6EDF3',
  padding: '9px 14px',
  textDecoration: 'none',
} as const;
