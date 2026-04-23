import Link from 'next/link';

const metrics = [
  { value: '1 bank', label: 'Shared across a cohort' },
  { value: 'Private', label: 'Uploads stay isolated per user' },
  { value: 'Exam-led', label: 'Scheduling adapts to deadlines' },
];

const workflow = [
  {
    eyebrow: '01',
    title: 'Publish a canonical deck once.',
    body: 'A class, study group, or tutor can maintain one shared question bank so everyone studies the same source material without duplicating setup.',
  },
  {
    eyebrow: '02',
    title: 'Track progress independently.',
    body: 'Each learner keeps separate quiz history, ratings, and spaced repetition state, even when the underlying bank is shared.',
  },
  {
    eyebrow: '03',
    title: 'Monetize private generation separately.',
    body: 'Uploading personal PDFs and generating a private library stays on the paid path, which keeps launch scope and pricing clean.',
  },
];

const capabilities = [
  'Shared banks for cohorts, labs, and tutoring groups',
  'Private PDF-to-question generation for paid users',
  'Concept maps, study queues, and spaced repetition review',
  'Supabase-backed auth and persistent learner progress',
];

export default function RootPage() {
  return (
    <main className="marketing-shell">
      <section className="marketing-hero">
        <div className="marketing-nav">
          <Link href="/" className="marketing-logo">
            Cardio
          </Link>
          <div className="marketing-nav-links">
            <a href="#workflow">Workflow</a>
            <a href="#access">Access model</a>
            <a href="#product">Product shape</a>
          </div>
          <div className="marketing-nav-actions">
            <Link href="/login" className="button button-ghost">
              Sign in
            </Link>
            <Link href="/app" className="button button-primary">
              Open app
            </Link>
          </div>
        </div>

        <div className="marketing-hero-grid">
          <div className="marketing-hero-copy">
            <div className="marketing-pill">
              <span className="marketing-pill-dot" />
              Shared study banks are free. Private generation is paid.
            </div>
            <p className="marketing-kicker">Clinical spaced repetition for assigned reading</p>
            <h1>
              One question bank for the cohort,
              <span> separate mastery for every learner.</span>
            </h1>
            <p className="marketing-lead">
              Cardio turns medical source material into a study system that works in two modes: a free shared bank that
              many learners can join, and a paid private workflow for users who want to upload their own PDFs and
              generate a personal library.
            </p>
            <div className="marketing-cta-row">
              <Link href="/login" className="button button-primary">
                Create account
              </Link>
              <Link href="/app" className="button button-secondary">
                Go to study app
              </Link>
            </div>
            <div className="marketing-metrics">
              {metrics.map(metric => (
                <div key={metric.label} className="marketing-metric-card">
                  <div className="marketing-metric-value">{metric.value}</div>
                  <div className="marketing-metric-label">{metric.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="marketing-stage" aria-label="Cardio product preview">
            <div className="marketing-stage-grid" />
            <div className="marketing-stage-orb" />
            <div className="marketing-stage-ring marketing-stage-ring-a" />
            <div className="marketing-stage-ring marketing-stage-ring-b" />

            <div className="marketing-floating-card marketing-floating-card-left">
              <div className="eyebrow">Shared deck</div>
              <div className="floating-title">Cardiology Board Review</div>
              <div className="floating-copy">211 evidence-grounded questions shared across a cohort.</div>
            </div>

            <div className="marketing-heart-panel">
              <div className="heart-panel-glow" />
              <div className="heart-panel-mark">Cardio</div>
              <div className="ekg-line" aria-hidden="true">
                <span />
              </div>
              <div className="heart-panel-core">
                <div className="heart-chip">Exam countdown synced</div>
                <div className="heart-title">Review intensity rises as the deadline approaches.</div>
                <div className="heart-copy">
                  Shared content stays consistent. Scheduling, flags, and recall strength remain personal.
                </div>
              </div>
            </div>

            <div className="marketing-floating-card marketing-floating-card-right">
              <div className="eyebrow">Private library</div>
              <div className="floating-title">Upload your own PDFs</div>
              <div className="floating-copy">Paid path for users who need isolated content generation.</div>
            </div>
          </div>
        </div>
      </section>

      <section className="marketing-band" id="product">
        <div className="marketing-band-inner">
          <p>The same Next.js app serves the public site at `/`, authentication at `/login`, and the signed-in product at `/app`.</p>
        </div>
      </section>

      <section className="marketing-section" id="workflow">
        <div className="section-heading">
          <p className="section-label">Workflow</p>
          <h2>A launch shape that keeps the product legible.</h2>
          <p>
            The core design decision is simple: shared banks reduce friction for group adoption, while private generation
            remains the premium workflow.
          </p>
        </div>
        <div className="workflow-grid">
          {workflow.map(item => (
            <article key={item.eyebrow} className="workflow-card">
              <p className="workflow-number">{item.eyebrow}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section">
        <div className="access-grid" id="access">
          <article className="access-card access-card-light">
            <p className="section-label">Free path</p>
            <h3>Join a published bank and study immediately.</h3>
            <p>
              Best for classes and shared cohorts. Learners sign in, join one bank, and keep their own progress without
              paying to regenerate the same material.
            </p>
            <ul className="marketing-list">
              <li>Shared source content</li>
              <li>Personal study history</li>
              <li>Independent spaced repetition state</li>
            </ul>
          </article>

          <article className="access-card access-card-dark">
            <p className="section-label section-label-dark">Paid path</p>
            <h3>Generate a private library from personal PDFs.</h3>
            <p>
              Best for individual learners who need isolated uploads, custom source sets, and their own bank generation
              pipeline.
            </p>
            <ul className="marketing-list marketing-list-dark">
              <li>Private uploads and processing</li>
              <li>Separate PDF libraries per user</li>
              <li>Billing only where generation adds cost</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="marketing-section marketing-section-tight">
        <div className="platform-card">
          <div className="section-heading section-heading-compact">
            <p className="section-label">Platform</p>
            <h2>Relevant product capabilities already fit this design direction.</h2>
          </div>
          <div className="platform-grid">
            {capabilities.map(item => (
              <div key={item} className="platform-item">
                <span className="platform-dot" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-footer-cta">
        <div className="marketing-footer-card">
          <div>
            <p className="section-label">Ready to ship</p>
            <h2>Deploy the Next app in `cardio` and use this page as the public front door.</h2>
          </div>
          <div className="marketing-cta-row">
            <Link href="/login" className="button button-primary">
              Start with login
            </Link>
            <Link href="/app" className="button button-secondary on-dark">
              Open product
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
