import Link from 'next/link';
import type { CSSProperties } from 'react';

const shell: CSSProperties = {
  minHeight: '100vh',
  background:
    'radial-gradient(circle at top left, rgba(13,154,170,0.16), transparent 32%), radial-gradient(circle at 85% 15%, rgba(34,197,94,0.10), transparent 26%), linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--bg) 92%, white 8%) 100%)',
  color: 'var(--text-primary)',
};

const section: CSSProperties = {
  maxWidth: '1100px',
  margin: '0 auto',
  padding: '0 24px',
};

const card: CSSProperties = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(16px)',
  border: '1px solid var(--border)',
  borderRadius: '18px',
  boxShadow: 'var(--shadow-md)',
};

const darkCard: CSSProperties = {
  ...card,
  background: 'rgba(20, 24, 30, 0.88)',
  color: '#F3F4F6',
  border: '1px solid rgba(255,255,255,0.08)',
};

const primaryButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '12px 18px',
  borderRadius: '12px',
  background: 'var(--accent)',
  color: '#fff',
  textDecoration: 'none',
  fontWeight: 700,
  boxShadow: '0 10px 24px rgba(13,154,170,0.22)',
};

const secondaryButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '12px 18px',
  borderRadius: '12px',
  border: '1px solid var(--border-med)',
  color: 'var(--text-primary)',
  textDecoration: 'none',
  fontWeight: 600,
  background: 'rgba(255,255,255,0.7)',
};

const footerLink: CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'none',
  fontWeight: 600,
};

export default function RootPage() {
  return (
    <main style={shell}>
      <header style={{ ...section, paddingTop: '24px', paddingBottom: '20px' }}>
        <div
          style={{
            ...card,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '20px',
            padding: '16px 20px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: '1rem',
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}
            >
              Cardio
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Shared study banks and private PDF generation for medical exam prep
            </span>
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <Link href="/login" style={secondaryButton}>
              Sign in
            </Link>
            <Link href="/app" style={primaryButton}>
              Open app
            </Link>
          </div>
        </div>
      </header>

      <section style={{ ...section, paddingTop: '44px', paddingBottom: '64px' }}>
        <div style={{ display: 'grid', gap: '28px', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(280px, 0.9fr)' }}>
          <div>
            <div
              style={{
                display: 'inline-flex',
                padding: '6px 12px',
                borderRadius: '999px',
                background: 'var(--accent-dim)',
                color: 'var(--accent)',
                fontSize: '0.8rem',
                fontWeight: 700,
                marginBottom: '18px',
              }}
            >
              Launch mode: shared banks are free, personal generation is paid
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: 'clamp(2.8rem, 8vw, 5.6rem)',
                lineHeight: 0.95,
                letterSpacing: '-0.06em',
                fontWeight: 800,
              }}
            >
              Turn assigned readings into
              <span style={{ color: 'var(--accent)', display: 'block' }}>usable question banks.</span>
            </h1>

            <p
              style={{
                marginTop: '20px',
                maxWidth: '720px',
                fontSize: '1.05rem',
                lineHeight: 1.7,
                color: 'var(--text-secondary)',
              }}
            >
              Cardio lets your group study one shared bank with independent progress, ratings, and SRS scheduling.
              When someone wants to upload their own PDFs and generate a private library, that becomes the paid path.
            </p>

            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '26px' }}>
              <Link href="/login" style={primaryButton}>
                Create account
              </Link>
              <Link href="/app" style={secondaryButton}>
                Go to study app
              </Link>
            </div>

            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginTop: '28px' }}>
              {[
                ['Free shared study', 'Users can join a published bank and keep their own progress.'],
                ['Paid personal generation', 'Uploading private PDFs is the monetized workflow.'],
                ['Feedback-ready', 'Collect flags, ratings, and study behavior from real learners.'],
              ].map(([title, body]) => (
                <div key={title} style={{ maxWidth: '220px' }}>
                  <div style={{ fontWeight: 700, marginBottom: '6px' }}>{title}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.92rem', lineHeight: 1.5 }}>{body}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ ...darkCard, padding: '24px' }}>
            <div style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.14em', color: '#7DD3FC' }}>
              First deploy checklist
            </div>
            <div style={{ marginTop: '18px', display: 'grid', gap: '14px' }}>
              {[
                'Deploy the Next app in /cardio as the site root.',
                'Configure Supabase auth, database migrations, and production redirect URLs.',
                'Set OpenAI and Stripe environment variables before enabling generation or billing.',
                'Use /app as the authenticated experience and / as the public website.',
              ].map(item => (
                <div key={item} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                  <span style={{ color: '#34D399', fontWeight: 700 }}>+</span>
                  <span style={{ color: '#D1D5DB', lineHeight: 1.5 }}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section style={{ ...section, paddingBottom: '64px' }}>
        <div style={{ display: 'grid', gap: '18px', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <FeatureCard
            title="Shared bank workflow"
            body="Publish one canonical question bank for a cohort. Each learner signs in, studies the same content, and keeps separate progress."
          />
          <FeatureCard
            title="Personal PDF workflow"
            body="Users who want their own private library can upload PDFs and generate a separate bank under a paid plan."
          />
          <FeatureCard
            title="Deployment shape"
            body="One Next.js app serves the website at /, auth at /login, and the product under /app."
          />
        </div>
      </section>

      <footer style={{ ...section, paddingBottom: '36px' }}>
        <div
          style={{
            ...card,
            display: 'flex',
            justifyContent: 'space-between',
            gap: '16px',
            padding: '18px 20px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
            Cardio now uses the Next app as the public site entrypoint.
          </div>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <Link href="/login" style={footerLink}>
              Login
            </Link>
            <Link href="/app" style={footerLink}>
              App
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ ...card, padding: '22px' }}>
      <div style={{ fontWeight: 700, fontSize: '1rem' }}>{title}</div>
      <div style={{ marginTop: '10px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}
