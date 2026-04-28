import Link from 'next/link';

const metrics = [
  { value: 'Evidence', label: 'Every question grounded in source text' },
  { value: 'SRS', label: 'Practice questions scheduled for memory' },
  { value: 'Remote', label: 'Anki remote compatible study flow' },
];

const workflow = [
  {
    eyebrow: '01',
    title: 'Upload medical source material.',
    body: 'Turn assigned chapters, board-review PDFs, and lecture packets into a private or shared practice-question bank.',
  },
  {
    eyebrow: '02',
    title: 'Practice like Anki, but with questions.',
    body: 'Answer clinically focused prompts, rate recall quality, and let spaced repetition bring weak concepts back on schedule.',
  },
  {
    eyebrow: '03',
    title: 'Keep every answer tied to evidence.',
    body: 'Questions carry source quotes and lightweight checks so learners can trace why an answer is correct.',
  },
];

const capabilities = [
  'Like Anki, but for practice questions',
  'Anki remote compatible keyboard-driven review',
  'Every question grounded in evidence',
  'Practice questions with spaced repetition for memory',
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
              Like Anki, but for practice questions
            </div>
            <p className="marketing-kicker">Medical-study SaaS for evidence-grounded recall</p>
            <h1>
              Practice questions with spaced repetition,
              <span> grounded in your medical sources.</span>
            </h1>
            <p className="marketing-lead">
              Cardio turns medical PDFs into answerable question banks for class, boards, and clinical review. Study with
              evidence-backed explanations, keyboard-first flow, and scheduling that behaves like Anki without reducing
              everything to flashcards.
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

      <section className="marketing-section" id="workflow">
        <div className="section-heading">
          <p className="section-label">Workflow</p>
          <h2>Build a medical question bank from the material you actually need to know.</h2>
          <p>
            Cardio keeps the familiar Anki rhythm while shifting the unit of practice from flashcards to source-grounded
            multiple-choice questions.
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
            <h3>Join a published medical-study bank and start practicing.</h3>
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
            <h3>Generate private practice questions from personal PDFs.</h3>
            <p>
              Best for individual learners who need isolated uploads, custom source sets, and their own bank generation
              pipeline.
            </p>
            <ul className="marketing-list marketing-list-dark">
              <li>Private uploads and processing</li>
              <li>Source quotes for answer evidence</li>
              <li>Spaced repetition for question memory</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="marketing-section marketing-section-tight">
        <div className="platform-card">
          <div className="section-heading section-heading-compact">
            <p className="section-label">Platform</p>
            <h2>Purpose-built for medical practice questions.</h2>
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
            <h2>Start practicing from shared banks or join the private-generation waitlist.</h2>
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
