import Link from 'next/link';

const stats = ['10,000+ SRS-optimized questions', 'Evidence-grounded', 'Cohort study banks'];

const features = [
  {
    number: '01',
    title: 'Ingest source material',
    body: 'Upload PDFs or paste guidelines; questions are auto-tagged to source sections.',
  },
  {
    number: '02',
    title: 'Study with SRS',
    body: 'SM-2 algorithm schedules reviews at optimal intervals; keyboard shortcuts keep flow fast.',
  },
  {
    number: '03',
    title: 'Share with cohort',
    body: "Publish decks to your study group; track who's reviewed what in the shared bank.",
  },
];

const freeItems = ['Access shared decks', '200 personal cards', 'Basic SRS scheduling', 'Community support'];
const proItems = ['Unlimited cards', 'PDF ingestion', 'Advanced analytics', 'Priority support', 'Team management'];

export default function RootPage() {
  return (
    <main className="home-page">
      <nav className="site-nav">
        <Link href="/" className="home-logo">
          Cardio
        </Link>
        <div className="home-nav-links" aria-label="Primary navigation">
          <a href="#features">Features</a>
          <a href="#workflow">How It Works</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div className="home-nav-actions">
          <Link href="/login" className="home-btn home-btn-ghost">
            Sign In
          </Link>
          <Link href="/app" className="home-btn home-btn-primary">
            Open App
          </Link>
        </div>
      </nav>

      <section className="home-hero">
        <div className="home-hero-copy">
          <div className="eyebrow-pill">
            <span className="pulse-dot" />
            Like Anki, but for practice questions
          </div>
          <h1>
            Every answer traceable to{' '}
            <em>source.</em>
          </h1>
          <p className="home-lead">
            Cardio turns assigned material into evidence-grounded, SRS-powered board prep with source quotes,
            exam-aware review timing, and shared banks built for cohort study.
          </p>
          <div className="home-cta-row">
            <Link href="/login" className="home-cta-primary">
              Create free account
            </Link>
            <Link href="/app" className="home-cta-ghost">
              Browse shared decks
            </Link>
          </div>
          <div className="home-stats" aria-label="Cardio highlights">
            {stats.map(stat => (
              <div key={stat} className="home-stat">
                {stat}
              </div>
            ))}
          </div>
        </div>

        <div className="hero-visual" aria-label="Cardio question review preview">
          <div className="hero-topbar">
            <span className="mac-dot mac-dot-red" />
            <span className="mac-dot mac-dot-yellow" />
            <span className="mac-dot mac-dot-green" />
          </div>
          <div className="hero-visual-body">
            <div className="hero-float-card hero-float-card-tl">
              <span>Shared deck</span>
              <strong>Cardiology Board Review</strong>
              <small>211 questions · 34 studying</small>
            </div>

            <article className="question-card-inner">
              <div className="question-chip">L2 · APPLICATION · Cardiology</div>
              <p className="question-stem">
                A 68-year-old man presents with acute onset crushing chest pain radiating to the left arm. ECG shows
                ST elevation in leads II, III, and aVF. Which coronary artery is most likely occluded?
              </p>
              <div className="answer-options">
                <div className="answer-option answer-option-wrong">
                  <span>A</span>
                  <p>Left anterior descending artery</p>
                </div>
                <div className="answer-option">
                  <span>B</span>
                  <p>Left circumflex artery</p>
                </div>
                <div className="answer-option answer-option-correct">
                  <span>C</span>
                  <p>Right coronary artery</p>
                </div>
                <div className="answer-option">
                  <span>D</span>
                  <p>Left main coronary artery</p>
                </div>
              </div>
              <blockquote className="source-quote">
                ST elevation in the inferior leads (II, III, aVF) indicates ischemia in the right coronary artery
                territory in approximately 80% of inferior MIs.
              </blockquote>
              <div className="rating-row" aria-label="Rate this review">
                <button className="rating-btn rating-again" type="button">
                  Again
                </button>
                <button className="rating-btn rating-hard" type="button">
                  Hard
                </button>
                <button className="rating-btn rating-good" type="button">
                  Good ✓
                </button>
                <button className="rating-btn rating-easy" type="button">
                  Easy
                </button>
              </div>
            </article>

            <div className="hero-float-card hero-float-card-br">
              <span>Next review: 4 days</span>
              <strong>47 cards due tomorrow</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="band-strip" aria-label="Platform capabilities">
        <span>Evidence-grounded questions</span>
        <span>SM-2 spaced repetition</span>
        <span>Exam-aware scheduling</span>
        <span>Shared cohort banks</span>
        <span>Keyboard-first flow</span>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="section-eyebrow">Workflow</div>
        <h2>Build your personal board review from assigned material.</h2>
        <div className="feature-grid" id="features">
          {features.map(feature => (
            <article className="feature-card" key={feature.number}>
              <div className="feature-number">{feature.number}</div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="access-section" id="pricing">
        <h2>One platform, two paths</h2>
        <div className="access-grid-new">
          <article className="access-card access-card-light-new">
            <span className="access-kicker">Free path</span>
            <h3>Study from shared banks.</h3>
            <div className="access-pill-list">
              {freeItems.map(item => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </article>
          <article className="access-card access-card-dark-new">
            <span className="access-kicker">Paid / Pro path</span>
            <h3>Generate and manage private banks.</h3>
            <div className="access-pill-list">
              {proItems.map(item => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="footer-wrap">
        <div className="footer-cta-block">
          <h2>Ready to make every study hour count?</h2>
          <div className="footer-actions">
            <Link href="/login" className="footer-primary">
              Get started free
            </Link>
            <Link href="/app" className="footer-ghost">
              View shared banks
            </Link>
          </div>
        </div>
        <p className="home-copyright">© 2026 Cardio. Evidence-grounded board prep for medical learners.</p>
      </section>
    </main>
  );
}
