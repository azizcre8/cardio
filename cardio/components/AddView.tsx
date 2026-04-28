'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { PDF, Density } from '@/types';
import { analyzePdfClient, type AnalyzeResult } from '@/lib/analyze-pdf-client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  pdfs:               PDF[];
  userEmail:          string | null;
  userPlan:           string;
  isJobRunning:       boolean;
  onStartProcessing:  (file: File, density: Density, maxQuestions: number) => void;
  onViewProcessing:   () => void;
  onOpenDeck:         (pdfId: string) => void;
}

type Step = 'drop' | 'analyzing' | 'configure';

const MODE_META: Record<Density, { label: string; desc: string; color: string }> = {
  standard:      { label: 'High Yield',    desc: 'Core concepts, boards-ready',        color: '#0D9AAA' },
  comprehensive: { label: 'Comprehensive', desc: 'Thorough coverage, all importance',   color: '#7C3AED' },
  boards:        { label: 'Boards Mode',   desc: 'Maximum density, clinical focus',     color: '#DC2626' },
};

function fmtTime(sec: number): string {
  if (sec < 60) return `~${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

function fmtWords(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AddView({ pdfs, userEmail, userPlan, isJobRunning, onStartProcessing, onViewProcessing, onOpenDeck }: Props) {
  const [step,         setStep]         = useState<Step>('drop');
  const [dragOver,     setDragOver]     = useState(false);
  const [search,       setSearch]       = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis,     setAnalysis]     = useState<AnalyzeResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [density,      setDensity]      = useState<Density>('standard');
  const [maxQEnabled,  setMaxQEnabled]  = useState(false);
  const [maxQ,         setMaxQ]         = useState(50);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canGenerate = userPlan === 'student' || userPlan === 'boards' || userPlan === 'institution';

  /* ── file handling ── */
  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setAnalyzeError('Only PDF files are supported.');
      return;
    }
    setSelectedFile(file);
    setAnalyzeError(null);
    setStep('analyzing');

    try {
      const result = await analyzePdfClient(file);
      setAnalysis(result);
      setStep('configure');
      // Default max Q to Standard's expected midpoint
      const est = result.estimates['standard'];
      if (est) setMaxQ(Math.round((est.questionsMin + est.questionsMax) / 2));
    } catch (e) {
      setAnalyzeError(`Couldn't analyze PDF: ${(e as Error).message}`);
      setStep('drop');
    }
  }, []);

  if (!canGenerate) {
    return <WaitlistGate email={userEmail ?? ''} />;
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function handleGenerate() {
    if (!selectedFile) return;
    onStartProcessing(selectedFile, density, maxQEnabled ? maxQ : 0);
  }

  function reset() {
    setStep('drop'); setSelectedFile(null); setAnalysis(null); setAnalyzeError(null);
  }

  /* ── filtered recent PDFs ── */
  const recent = [...pdfs]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .filter(p => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()));

  const currentEst = analysis?.estimates[density];

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto' }}>

      {/* ── Background job banner ── */}
      {isJobRunning && (
        <button
          onClick={onViewProcessing}
          style={{
            width: '100%', marginBottom: '20px',
            padding: '12px 18px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(20,184,200,0.08)',
            border: '1px solid rgba(20,184,200,0.25)',
            display: 'flex', alignItems: 'center', gap: '10px',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: '#14B8C8', flexShrink: 0,
            animation: 'processing-badge 1.2s ease-in-out infinite',
          }} />
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--accent)' }}>
            Processing in background — click to view progress
          </span>
          <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-dim)' }}>→</span>
        </button>
      )}

      {/* ── Drop zone ── */}
      {step === 'drop' && (
        <DropZone
          dragOver={dragOver}
          error={analyzeError}
          fileInputRef={fileInputRef}
          onDrop={onDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileInputRef.current?.click()}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
      )}

      {/* ── Analyzing ── */}
      {step === 'analyzing' && selectedFile && (
        <AnalyzingCard name={selectedFile.name} />
      )}

      {/* ── Configure ── */}
      {step === 'configure' && selectedFile && analysis && (
        <ConfigureCard
          file={selectedFile}
          analysis={analysis}
          density={density}
          maxQEnabled={maxQEnabled}
          maxQ={maxQ}
          onDensityChange={setDensity}
          onMaxQEnabledChange={setMaxQEnabled}
          onMaxQChange={setMaxQ}
          onGenerate={handleGenerate}
          onReset={reset}
          currentEst={currentEst}
        />
      )}

      {/* ── Recent PDFs ── */}
      <section style={{ marginTop: step === 'drop' ? '36px' : '32px' }}>
        {/* Section header + search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
          <h2 style={{
            fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: 'var(--text-dim)',
            flexShrink: 0,
          }}>
            Recent PDFs
          </h2>
          <div style={{ flex: 1, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }}
              width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="8.5" cy="8.5" r="5.5" /><line x1="13" y1="13" x2="17.5" y2="17.5" />
            </svg>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search PDFs…"
              style={{
                width: '100%', height: '32px', paddingLeft: '28px', paddingRight: '10px',
                borderRadius: 'var(--radius-md)', fontSize: '0.8rem',
                background: 'var(--bg-sunken)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', outline: 'none',
              }}
              onFocus={e  => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e   => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>
        </div>

        {/* PDF list */}
        {recent.length === 0 ? (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', padding: '20px 0', textAlign: 'center' }}>
            {search.trim() ? `No PDFs match "${search}"` : 'No PDFs uploaded yet'}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {recent.map(pdf => <RecentRow key={pdf.id} pdf={pdf} onOpen={onOpenDeck} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function WaitlistGate({ email }: { email: string }) {
  const [formEmail, setFormEmail] = useState(email);
  const [useCase, setUseCase] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (email && !formEmail) setFormEmail(email);
  }, [email, formEmail]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: formEmail, use_case: useCase }),
    });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    setSubmitting(false);
    if (!res.ok) {
      setStatus(data?.error ?? 'Could not join the waitlist.');
      return;
    }
    setStatus('You are on the waitlist. We will email you when private PDF generation opens.');
    setUseCase('');
  }

  return (
    <div style={{ maxWidth: 560, margin: '56px auto 0' }}>
      <div style={{
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: 28,
        boxShadow: 'var(--shadow-1)',
      }}>
        <p style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--accent)',
          marginBottom: 8,
        }}>
          Private generation waitlist
        </p>
        <h1 style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 32,
          fontWeight: 400,
          color: 'var(--text-primary)',
          margin: '0 0 10px',
        }}>
          PDF generation is reserved for paid beta seats.
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-secondary)', margin: '0 0 22px' }}>
          Free accounts can study shared banks now. Join the waitlist to get access to private medical-study question generation.
        </p>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="email"
            value={formEmail}
            onChange={e => setFormEmail(e.target.value)}
            placeholder="Email"
            required
            style={{
              height: 40,
              borderRadius: 'var(--r2)',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              padding: '0 12px',
              outline: 'none',
            }}
          />
          <textarea
            value={useCase}
            onChange={e => setUseCase(e.target.value)}
            placeholder="What will you use it for?"
            required
            rows={4}
            style={{
              borderRadius: 'var(--r2)',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              padding: 12,
              resize: 'vertical',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={submitting}
            style={{
              height: 40,
              borderRadius: 'var(--r2)',
              border: 'none',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              fontSize: 13,
              fontWeight: 700,
              cursor: submitting ? 'default' : 'pointer',
              opacity: submitting ? 0.65 : 1,
            }}
          >
            {submitting ? 'Joining...' : 'Join waitlist'}
          </button>
        </form>
        {status && (
          <p style={{ margin: '14px 0 0', fontSize: 12, color: status.startsWith('You are') ? 'var(--green)' : 'var(--red)' }}>
            {status}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Drop Zone ─────────────────────────────────────────────────────────────────

function DropZone({ dragOver, error, fileInputRef, onDrop, onDragOver, onDragLeave, onClick, onChange }: {
  dragOver:    boolean;
  error:       string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onDrop:      (e: React.DragEvent) => void;
  onDragOver:  (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onClick:     () => void;
  onChange:    (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={onClick}
        onKeyDown={e => e.key === 'Enter' && onClick()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border-med)'}`,
          borderRadius: 'var(--radius-lg)',
          background:   dragOver ? 'var(--accent-dim)' : 'var(--bg-raised)',
          padding:      '60px 32px',
          textAlign:    'center',
          cursor:       'pointer',
          transition:   'border-color 0.2s, background 0.2s, box-shadow 0.2s',
          boxShadow:    dragOver ? '0 0 24px 4px rgba(13,154,170,0.12)' : 'none',
          animation:    dragOver ? 'drop-glow 1.5s ease-in-out infinite' : undefined,
          outline:      'none',
        }}
      >
        {/* Icon */}
        <div style={{
          width: '64px', height: '64px', margin: '0 auto 20px',
          borderRadius: '50%',
          background: dragOver ? 'rgba(13,154,170,0.15)' : 'var(--bg-sunken)',
          border: `1px solid ${dragOver ? 'rgba(13,154,170,0.3)' : 'var(--border)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.2s',
          transform: dragOver ? 'scale(1.08)' : 'scale(1)',
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
            stroke={dragOver ? 'var(--accent)' : 'var(--text-dim)'} strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="12" x2="12" y2="18" />
            <polyline points="9 15 12 12 15 15" />
          </svg>
        </div>

        <p style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>
          {dragOver ? 'Release to upload' : 'Drop your PDF here'}
        </p>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginBottom: '20px' }}>
          or click to browse files
        </p>

        <span style={{
          display: 'inline-block',
          padding: '8px 24px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--accent)', color: 'white',
          fontSize: '0.82rem', fontWeight: 600,
          pointerEvents: 'none',
        }}>
          Select PDF
        </span>

        <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '14px' }}>
          PDF files only
        </p>
      </div>

      {error && (
        <p style={{ marginTop: '10px', fontSize: '0.8rem', color: 'var(--red)', textAlign: 'center' }}>
          {error}
        </p>
      )}

      <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={onChange} />
    </div>
  );
}

// ── Analyzing Card ─────────────────────────────────────────────────────────────

function AnalyzingCard({ name }: { name: string }) {
  return (
    <div style={{
      background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '36px',
      textAlign: 'center',
    }}>
      {/* Pulsing rings */}
      <div style={{ position: 'relative', width: '56px', height: '56px', margin: '0 auto 20px' }}>
        {[0, 1].map(i => (
          <div key={i} style={{
            position: 'absolute', inset: i * -10,
            borderRadius: '50%',
            border: '1.5px solid rgba(13,154,170,0.3)',
            animation: `pulse-out ${1.6 + i * 0.4}s ease-out ${i * 0.4}s infinite`,
          }} />
        ))}
        <div style={{
          position: 'absolute', inset: '12px',
          borderRadius: '50%', background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
      </div>
      <p style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Scanning PDF…</p>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-dim)', marginBottom: '4px' }}>
        Counting pages and estimating question yield
      </p>
      <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
        {name}
      </p>
    </div>
  );
}

// ── Configure Card ─────────────────────────────────────────────────────────────

function ConfigureCard({
  file, analysis, density, maxQEnabled, maxQ, currentEst,
  onDensityChange, onMaxQEnabledChange, onMaxQChange, onGenerate, onReset,
}: {
  file:              File;
  analysis:          AnalyzeResult;
  density:           Density;
  maxQEnabled:       boolean;
  maxQ:              number;
  currentEst:        { questionsMin: number; questionsMax: number; timeSec: number } | undefined;
  onDensityChange:   (d: Density) => void;
  onMaxQEnabledChange:(v: boolean) => void;
  onMaxQChange:      (n: number) => void;
  onGenerate:        () => void;
  onReset:           () => void;
}) {
  return (
    <div style={{
      background: 'var(--bg-raised)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '28px',
    }}>
      {/* PDF summary */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '24px' }}>
        <div style={{
          width: '44px', height: '44px', flexShrink: 0,
          borderRadius: 'var(--radius-md)',
          background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.name.replace(/\.pdf$/i, '')}
          </p>
          <div style={{ display: 'flex', gap: '14px', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            <span>{analysis.pageCount} pages</span>
            <span>~{fmtWords(analysis.estimatedTotalWords)} words</span>
          </div>
        </div>
        <button
          onClick={onReset}
          style={{
            fontSize: '0.72rem', color: 'var(--text-dim)',
            background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          ✕ Change
        </button>
      </div>

      {/* Mode selector */}
      <div style={{ marginBottom: '22px' }}>
        <p style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: '10px' }}>
          Generation Mode
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
          {(['standard', 'comprehensive', 'boards'] as Density[]).map(mode => {
            const meta = MODE_META[mode];
            const est  = analysis.estimates[mode];
            const active = density === mode;
            return (
              <button
                key={mode}
                onClick={() => onDensityChange(mode)}
                style={{
                  padding: '14px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: `1.5px solid ${active ? meta.color : 'var(--border)'}`,
                  background: active ? `${meta.color}12` : 'var(--bg-sunken)',
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'all 0.15s',
                }}
              >
                <p style={{ fontSize: '0.78rem', fontWeight: 700, color: active ? meta.color : 'var(--text-primary)', marginBottom: '3px' }}>
                  {meta.label}
                </p>
                <p style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '8px', lineHeight: 1.3 }}>
                  {meta.desc}
                </p>
                {est && (
                  <>
                    <p style={{ fontSize: '0.7rem', fontWeight: 600, color: active ? meta.color : 'var(--text-secondary)' }}>
                      {est.questionsMin}–{est.questionsMax} Qs
                    </p>
                    <p style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                      {fmtTime(est.timeSec)}
                    </p>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Max questions toggle */}
      <div style={{
        marginBottom: '24px',
        padding: '16px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: maxQEnabled ? '14px' : '0' }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>
              Maximum questions per chapter
            </p>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
              {maxQEnabled
                ? `Top ${maxQ} questions selected by quality`
                : 'All passing questions will be included'}
            </p>
          </div>
          {/* Toggle switch */}
          <button
            role="switch"
            aria-checked={maxQEnabled}
            onClick={() => onMaxQEnabledChange(!maxQEnabled)}
            style={{
              width: '44px', height: '24px', flexShrink: 0,
              borderRadius: '12px', border: 'none', cursor: 'pointer',
              background: maxQEnabled ? 'var(--accent)' : 'var(--border-med)',
              position: 'relative', transition: 'background 0.2s',
            }}
          >
            <span style={{
              position: 'absolute', top: '3px',
              left: maxQEnabled ? '22px' : '3px',
              width: '18px', height: '18px',
              borderRadius: '50%', background: 'white',
              transition: 'left 0.2s',
              boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
            }} />
          </button>
        </div>

        {maxQEnabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="range"
              min={10}
              max={currentEst ? currentEst.questionsMax : 500}
              step={5}
              value={maxQ}
              onChange={e => onMaxQChange(parseInt(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--accent)' }}
            />
            <input
              type="number"
              min={1}
              max={9999}
              value={maxQ}
              onChange={e => onMaxQChange(Math.max(1, parseInt(e.target.value) || 1))}
              style={{
                width: '64px', height: '32px', textAlign: 'center',
                borderRadius: 'var(--radius-sm)', fontSize: '0.85rem', fontWeight: 600,
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                color: 'var(--accent)', outline: 'none',
              }}
              onFocus={e  => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e   => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
            <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>max Qs</span>
          </div>
        )}
      </div>

      {/* Summary row */}
      {currentEst && (
        <div style={{
          display: 'flex', gap: '8px', marginBottom: '20px',
          padding: '12px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--accent-dim)',
          border: '1px solid rgba(13,154,170,0.15)',
          fontSize: '0.78rem',
        }}>
          <span style={{ color: 'var(--text-dim)' }}>Est. result:</span>
          <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
            {maxQEnabled
              ? `top ${maxQ} questions`
              : `${currentEst.questionsMin}–${currentEst.questionsMax} questions`}
          </span>
          <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>
            {fmtTime(currentEst.timeSec)}
          </span>
        </div>
      )}

      {/* CTA */}
      <button
        onClick={onGenerate}
        style={{
          width: '100%', padding: '14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--accent)', color: 'white',
          fontSize: '0.9rem', fontWeight: 700, border: 'none',
          cursor: 'pointer', letterSpacing: '0.01em',
          transition: 'opacity 0.15s, transform 0.1s',
        }}
        onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'none'; }}
        onMouseDown={e  => { e.currentTarget.style.transform = 'translateY(0)'; }}
      >
        Generate Question Bank →
      </button>
    </div>
  );
}

// ── Recent Row ─────────────────────────────────────────────────────────────────

function RecentRow({ pdf, onOpen }: { pdf: PDF; onOpen: (id: string) => void }) {
  const [hov, setHov] = useState(false);
  const isReady = !!pdf.processed_at;
  const name    = pdf.name.replace(/\.pdf$/i, '');

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '12px 14px',
        borderRadius: 'var(--radius-md)',
        background: hov ? 'var(--bg-raised)' : 'transparent',
        border: `1px solid ${hov ? 'var(--border-med)' : 'transparent'}`,
        cursor: isReady ? 'pointer' : 'default',
        transition: 'all 0.15s',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={() => isReady && onOpen(pdf.id)}
    >
      {/* Status dot */}
      <div style={{
        width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
        background: isReady ? 'var(--green)' : 'var(--amber)',
        animation: !isReady ? 'ekg-pulse-dot 1.4s ease-in-out infinite' : undefined,
      }} />

      {/* Name */}
      <p style={{
        flex: 1, fontSize: '0.85rem', fontWeight: 500,
        color: 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={name}>
        {name}
      </p>

      {/* Meta chips */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
        {pdf.page_count > 0 && (
          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
            {pdf.page_count}pp
          </span>
        )}
        {pdf.question_count != null && (
          <span style={{
            fontSize: '0.68rem', fontWeight: 600, padding: '1px 7px',
            borderRadius: '99px', background: 'var(--bg-sunken)',
            border: '1px solid var(--border)', color: 'var(--text-secondary)',
          }}>
            {pdf.question_count} Qs
          </span>
        )}
        {!isReady && (
          <span style={{ fontSize: '0.68rem', color: 'var(--amber)', fontWeight: 600 }}>
            processing
          </span>
        )}
        <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
          {fmtDate(pdf.created_at)}
        </span>
      </div>

      {/* Open arrow (hover) */}
      {isReady && (
        <span style={{ fontSize: '0.8rem', color: 'var(--accent)', opacity: hov ? 1 : 0, transition: 'opacity 0.15s' }}>
          →
        </span>
      )}
    </div>
  );
}
