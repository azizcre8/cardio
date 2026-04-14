'use client';

import { useEffect, useState, useRef } from 'react';
import type { ProcessEvent } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActiveJob {
  pdfName:        string;
  density:        string;
  maxQuestions:   number;    // 0 = unlimited
  logs:           ProcessEvent[];
  isRunning:      boolean;
  startedAt:      number;    // Date.now()
  completedPdfId: string | null;
}

interface Props {
  job:      ActiveJob;
  onBack:   () => void;
}

// ── EKG waveform path builder ─────────────────────────────────────────────────
// One PQRST cycle in 0–200 x-space, baseline at y=40, amplitude 0–58

function beatPath(offsetX: number): string {
  const pts: [number, number][] = [
    [0,  40], [16, 40],           // flat baseline
    [22, 34], [28, 21], [34, 34], [40, 40], // P wave
    [44, 40],                     // PR segment
    [48, 37], [52, 4], [56, 54], [60, 40],  // QRS complex
    [72, 40],                     // ST segment
    [78, 30], [92, 14], [106, 30], [112, 40], // T wave
    [200, 40],                    // flat to next beat
  ];
  return pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x + offsetX},${y}`).join(' ');
}

// 4 beats → seamless 2-beat loop
const EKG_PATH = [0, 200, 400, 600].map(beatPath).join(' ');

// ── Grid line helper (ECG paper) ──────────────────────────────────────────────

function GridLines() {
  const hLines = [10, 20, 30, 40, 50, 58];
  const vLines = [100, 200, 300, 400, 500, 600, 700];
  return (
    <g opacity={0.08}>
      {hLines.map(y => <line key={y} x1="0" y1={y} x2="800" y2={y} stroke="#14B8C8" strokeWidth="0.5" />)}
      {vLines.map(x => <line key={x} x1={x} y1="0" x2={x} y2="60" stroke="#14B8C8" strokeWidth="0.5" />)}
    </g>
  );
}

// ── Phase labels ──────────────────────────────────────────────────────────────

const PHASES = [
  'Extracting text',
  'Semantic chunking',
  'Building embeddings',
  'Mapping concepts',
  'Generating questions',
  'Validating quality',
];

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '10px',
      padding: '14px 16px',
    }}>
      <div style={{
        fontFamily: "'Source Serif 4', Georgia, serif",
        fontSize: '1.7rem', fontWeight: 300,
        color: dim ? '#4A5E7A' : '#E6EDF3',
        letterSpacing: '-0.04em', lineHeight: 1,
        marginBottom: '5px',
      }}>
        {value}
      </div>
      <div style={{
        fontSize: '0.6rem', fontWeight: 700,
        letterSpacing: '0.1em', textTransform: 'uppercase',
        color: '#3D4652',
      }}>
        {label}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ProcessingView({ job, onBack }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* live elapsed timer */
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - job.startedAt) / 1000));
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [job.startedAt]);

  const latest      = job.logs[job.logs.length - 1];
  const pct         = latest?.pct ?? 0;
  const phase       = latest?.phase ?? 0;
  const isDone      = phase >= 7 && !job.isRunning;
  const message     = latest?.message ?? 'Initialising…';

  /* live metrics from data payloads */
  const wordsParsed        = (job.logs.map(e => e.data?.wordsParsed).filter(Boolean).pop() as number | undefined) ?? 0;
  const conceptsGenerated  = (job.logs.map(e => e.data?.conceptsGenerated).filter(Boolean).pop() as number | undefined) ?? 0;
  const questionsGenerated = (job.logs.map(e => e.data?.questionsGenerated).filter(Boolean).pop() as number | undefined) ?? 0;
  const questionsRejected  = (job.logs.map(e => e.data?.questionsRejected).filter(Boolean).pop() as number | undefined) ?? 0;

  /* quality rate */
  const qualityTotal = questionsGenerated + questionsRejected;
  const qualityRate  = qualityTotal > 0 ? Math.round((questionsGenerated / qualityTotal) * 100) : null;

  /* time remaining estimate */
  const estimatedTotal   = pct > 5 ? Math.round(elapsed / (pct / 100)) : null;
  const estimatedRemain  = estimatedTotal ? Math.max(0, estimatedTotal - elapsed) : null;

  /* EKG animation speed: slower at start, faster near end */
  const animDuration = Math.max(0.30, 1.0 - (pct / 100) * 0.70).toFixed(2);

  /* format helpers */
  function fmtSec(s: number): string {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  function fmtNum(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  return (
    <div style={{
      minHeight: 'calc(100vh - 56px)',
      background: '#080C12',
      padding: '32px 20px',
      display: 'flex', flexDirection: 'column',
      color: '#E6EDF3',
    }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%', flex: 1 }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: '#3D4652',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '4px 0', flexShrink: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = '#8B949E')}
            onMouseLeave={e => (e.currentTarget.style.color = '#3D4652')}
          >
            ← Back to study
          </button>

          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#3D4652', marginBottom: '2px' }}>
              {isDone ? 'Complete' : 'Generating question bank'}
            </p>
            <p style={{
              fontSize: '0.88rem', fontWeight: 600, color: '#8B949E',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {job.pdfName.replace(/\.pdf$/i, '')}
            </p>
          </div>

          {/* Pct badge */}
          <div style={{
            fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: '2.2rem', fontWeight: 300, flexShrink: 0,
            color: isDone ? '#3FB950' : '#14B8C8',
            letterSpacing: '-0.04em',
            transition: 'color 0.4s',
          }}>
            {pct}%
          </div>
        </div>

        {/* ── EKG animation ── */}
        <div style={{
          position: 'relative',
          background: 'rgba(20,184,200,0.04)',
          border: '1px solid rgba(20,184,200,0.1)',
          borderRadius: '12px',
          overflow: 'hidden',
          height: '80px',
          marginBottom: '4px',
        }}>
          {/* Scan-line shimmer */}
          <div style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(90deg, transparent 0%, rgba(20,184,200,0.04) 50%, transparent 100%)',
            animation: 'shimmer 4s ease-in-out infinite',
            pointerEvents: 'none',
          }} />

          <svg
            viewBox="0 0 800 60"
            preserveAspectRatio="none"
            style={{
              width: '200%',
              height: '100%',
              display: 'block',
              animationName: isDone ? undefined : 'ekg-scroll',
              animationDuration: `${animDuration}s`,
              animationTimingFunction: 'linear',
              animationIterationCount: 'infinite',
            }}
          >
            <defs>
              <filter id="ekgGlow" x="-20%" y="-50%" width="140%" height="200%">
                <feGaussianBlur stdDeviation="2.5" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <GridLines />
            {/* glow layer */}
            <path d={EKG_PATH} fill="none" stroke="#14B8C8" strokeWidth="3" filter="url(#ekgGlow)" opacity="0.4" />
            {/* crisp line */}
            <path
              d={EKG_PATH}
              fill="none"
              stroke={isDone ? '#3FB950' : '#14B8C8'}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transition: 'stroke 0.5s' }}
            />
          </svg>
        </div>

        {/* BPM label */}
        <div style={{
          textAlign: 'right', fontSize: '0.6rem', fontWeight: 600,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: '#3D4652', marginBottom: '20px',
        }}>
          {isDone ? 'Done' : `${Math.round(60 / parseFloat(animDuration))} BPM`}
        </div>

        {/* ── Progress bar ── */}
        <div style={{
          height: '4px', background: 'rgba(255,255,255,0.05)',
          borderRadius: '2px', overflow: 'hidden', marginBottom: '28px',
        }}>
          <div style={{
            height: '100%', width: `${pct}%`,
            background: isDone
              ? 'linear-gradient(90deg, #3FB950, #3FB950)'
              : 'linear-gradient(90deg, #0D9AAA, #14B8C8)',
            borderRadius: '2px',
            transition: 'width 0.6s ease, background 0.4s',
            position: 'relative', overflow: 'hidden',
          }}>
            {!isDone && (
              <div style={{
                position: 'absolute', top: 0, right: '-40px', bottom: 0, width: '80px',
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
                animation: 'shimmer 1.2s ease-in-out infinite',
              }} />
            )}
          </div>
        </div>

        {/* ── Stats grid ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '10px',
          marginBottom: '24px',
        }}>
          <StatCard label="Time Elapsed"     value={fmtSec(elapsed)} />
          <StatCard
            label="Est. Remaining"
            value={isDone ? '—' : estimatedRemain !== null ? fmtSec(estimatedRemain) : '…'}
            dim={estimatedRemain === null && !isDone}
          />
          <StatCard label="Words Parsed"      value={wordsParsed ? fmtNum(wordsParsed) : '—'}    dim={!wordsParsed} />
          <StatCard label="Concepts Found"    value={conceptsGenerated ? String(conceptsGenerated) : '—'} dim={!conceptsGenerated} />
          <StatCard label="Questions Generated" value={questionsGenerated ? String(questionsGenerated) : '—'} dim={!questionsGenerated} />
          <StatCard label="Questions Rejected"  value={questionsRejected ? String(questionsRejected)  : '—'} dim={!questionsRejected} />
        </div>

        {/* ── Quality + completion metrics ── */}
        <div style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '10px',
          padding: '16px 18px',
          marginBottom: '24px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '14px' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#3D4652' }}>
              Quality Rate
            </span>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: qualityRate !== null ? '#14B8C8' : '#3D4652' }}>
              {qualityRate !== null ? `${qualityRate}%` : '—'}
            </span>
          </div>
          {/* Quality bar */}
          <div style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginBottom: '14px' }}>
            <div style={{
              height: '100%', width: `${qualityRate ?? 0}%`,
              background: 'linear-gradient(90deg, #0D9AAA, #3FB950)',
              borderRadius: '2px', transition: 'width 0.6s ease',
            }} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#3D4652' }}>
              Pipeline Completion
            </span>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#14B8C8' }}>{pct}%</span>
          </div>
          {/* Completion bar */}
          <div style={{ height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginTop: '8px' }}>
            <div style={{
              height: '100%', width: `${pct}%`,
              background: isDone ? '#3FB950' : 'linear-gradient(90deg, #0D9AAA, #14B8C8)',
              borderRadius: '2px', transition: 'width 0.6s ease, background 0.4s',
            }} />
          </div>
        </div>

        {/* ── Phase steps ── */}
        <div style={{
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '10px',
          padding: '16px 18px',
          marginBottom: '24px',
        }}>
          <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#3D4652', marginBottom: '12px' }}>
            Pipeline Stages
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
            {PHASES.map((label, i) => {
              const num    = i + 1;
              const done   = isDone || phase > num;
              const active = !isDone && phase === num;
              return (
                <div key={num} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  opacity: !done && !active ? 0.3 : 1, transition: 'opacity 0.3s',
                }}>
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: done ? '#14B8C8' : active ? 'rgba(20,184,200,0.1)' : 'rgba(255,255,255,0.04)',
                    border: active ? '1.5px solid rgba(20,184,200,0.5)' : 'none',
                    animation: active ? 'spin-slow 2.5s linear infinite' : undefined,
                  }}>
                    {done ? (
                      <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5">
                        <polyline points="2,6 5,10 10,2" />
                      </svg>
                    ) : active ? (
                      <div style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#14B8C8' }} />
                    ) : null}
                  </div>
                  <span style={{
                    fontSize: '0.72rem',
                    color: done ? '#4A5E7A' : active ? '#E6EDF3' : '#2D3A4A',
                    fontWeight: active ? 500 : 400,
                  }}>
                    {label}
                  </span>
                  {active && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#14B8C8', animation: 'fade-up 0.25s ease' }}>
                      working…
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Latest message ── */}
        <p style={{
          fontSize: '0.72rem', color: '#3D4652',
          textAlign: 'center', fontStyle: 'italic',
          minHeight: '18px',
        }}>
          {message}
        </p>

        {/* ── Done state ── */}
        {isDone && (
          <div style={{
            marginTop: '24px', padding: '20px',
            background: 'rgba(63,185,80,0.08)',
            border: '1px solid rgba(63,185,80,0.2)',
            borderRadius: '10px',
            textAlign: 'center',
            animation: 'fade-up 0.4s ease',
          }}>
            <p style={{ fontWeight: 700, color: '#3FB950', marginBottom: '6px' }}>
              Question bank complete!
            </p>
            <p style={{ fontSize: '0.82rem', color: '#4A5E7A' }}>
              {questionsGenerated} questions generated · {qualityRate !== null ? `${qualityRate}% quality rate` : ''}
            </p>
            <button
              onClick={onBack}
              style={{
                marginTop: '14px', padding: '10px 28px',
                borderRadius: '8px',
                background: '#3FB950', color: 'white',
                fontSize: '0.82rem', fontWeight: 700, border: 'none',
                cursor: 'pointer',
              }}
            >
              View in Library →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
