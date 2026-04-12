'use client';

import type { ProcessEvent } from '@/types';

const PHASES = [
  { label: 'Extracting text',       icon: '📄' },
  { label: 'Semantic chunking',     icon: '✂️' },
  { label: 'Building embeddings',   icon: '🧬' },
  { label: 'Mapping concepts',      icon: '🗺️' },
  { label: 'Generating questions',  icon: '💡' },
  { label: 'Validating quality',    icon: '✅' },
];

export default function ProcessingLog({ events }: { events: ProcessEvent[] }) {
  const latest      = events[events.length - 1];
  const pct         = latest?.pct ?? 0;
  const currentPhase = latest?.phase ?? 0;
  const isDone      = currentPhase >= 7;

  return (
    <div
      style={{
        background:           'linear-gradient(135deg, #0D1117 0%, #161B22 60%, #0A1020 100%)',
        backgroundSize:       '200% 200%',
        animation:            'gradient-flow 6s ease infinite',
        borderRadius:         'var(--radius-lg)',
        padding:              '28px 28px 24px',
        position:             'relative',
        overflow:             'hidden',
        border:               '1px solid rgba(20,184,200,0.12)',
      }}
    >
      {/* Subtle scan shimmer */}
      <div
        style={{
          position:   'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(20,184,200,0.025) 50%, transparent 100%)',
          animation:  'shimmer 4s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      />

      {/* ECG accent line */}
      <div style={{ marginBottom: '22px', opacity: 0.5 }}>
        <svg width="100%" height="24" viewBox="0 0 300 24" preserveAspectRatio="none">
          <polyline
            points="0,12 30,12 40,4 50,20 60,12 70,12 80,4 90,20 100,12 300,12"
            fill="none"
            stroke="#14B8C8"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="300"
            style={{ animation: 'ecg-draw 2s ease forwards' }}
          />
        </svg>
      </div>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '22px' }}>
        {/* Pulsing ring icon */}
        <div style={{ position: 'relative', width: '44px', height: '44px', flexShrink: 0 }}>
          {!isDone && (
            <>
              <div style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: 'rgba(20,184,200,0.12)',
                animation:  'pulse-out 1.8s ease-out infinite',
              }} />
              <div style={{
                position: 'absolute', inset: '4px', borderRadius: '50%',
                background: 'rgba(20,184,200,0.18)',
                animation:  'pulse-out 1.8s ease-out 0.5s infinite',
              }} />
            </>
          )}
          <div style={{
            position:       'absolute', inset: '10px',
            borderRadius:   '50%',
            background:     isDone ? '#3FB950' : 'var(--accent)',
            display:        'flex', alignItems: 'center', justifyContent: 'center',
            transition:     'background 0.4s ease',
          }}>
            {isDone ? (
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="2.5">
                <polyline points="2,7 6,11 12,3" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#E6EDF3', fontWeight: 600, fontSize: '0.875rem', marginBottom: '4px' }}>
            {isDone ? 'Processing complete!' : 'Analysing chapter…'}
          </div>
          <div style={{
            color: '#4A5E7A', fontSize: '0.72rem',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {latest?.message ?? 'Initialising pipeline…'}
          </div>
        </div>

        {/* Percentage */}
        <div style={{
          fontFamily:    "'Source Serif 4', Georgia, serif",
          fontSize:      '2.2rem', fontWeight: 300,
          color:         isDone ? '#3FB950' : '#14B8C8',
          letterSpacing: '-0.04em', lineHeight: 1,
          transition:    'color 0.4s ease',
          flexShrink:    0,
        }}>
          {pct}%
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height:       '3px',
        background:   'rgba(255,255,255,0.05)',
        borderRadius: '2px',
        marginBottom: '22px',
        overflow:     'hidden',
        position:     'relative',
      }}>
        <div style={{
          height:     '100%',
          width:      `${pct}%`,
          background: isDone
            ? 'linear-gradient(90deg, #3FB950, #3FB950)'
            : 'linear-gradient(90deg, #0D9AAA, #14B8C8)',
          borderRadius: '2px',
          transition:   'width 0.6s ease, background 0.4s ease',
          position:     'relative',
          overflow:     'hidden',
        }}>
          {!isDone && (
            <div style={{
              position:   'absolute', top: 0, right: '-40px', bottom: 0, width: '80px',
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
              animation:  'shimmer 1.2s ease-in-out infinite',
            }} />
          )}
        </div>
      </div>

      {/* Phase steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {PHASES.map((phase, i) => {
          const phaseNum = i + 1;
          const done     = isDone || currentPhase > phaseNum;
          const active   = !isDone && currentPhase === phaseNum;
          const pending  = !isDone && currentPhase < phaseNum;

          return (
            <div
              key={phaseNum}
              style={{
                display:    'flex',
                alignItems: 'center',
                gap:        '12px',
                opacity:    pending ? 0.3 : 1,
                transition: 'opacity 0.3s ease',
                animation:  active ? 'fade-up 0.25s ease both' : undefined,
              }}
            >
              {/* Status circle */}
              <div style={{
                width:          '22px', height: '22px',
                borderRadius:   '50%',
                flexShrink:     0,
                display:        'flex', alignItems: 'center', justifyContent: 'center',
                background:     done
                  ? '#14B8C8'
                  : active
                    ? 'rgba(20,184,200,0.12)'
                    : 'rgba(255,255,255,0.04)',
                border:         active ? '1.5px solid rgba(20,184,200,0.5)' : 'none',
                animation:      active ? 'spin-slow 2.5s linear infinite' : undefined,
              }}>
                {done ? (
                  <svg
                    width="9" height="9" viewBox="0 0 12 12"
                    fill="none" stroke="white" strokeWidth="2.5"
                    style={{ animation: 'tick-in 0.2s ease' }}
                  >
                    <polyline points="2,6 5,10 10,2" />
                  </svg>
                ) : active ? (
                  <div style={{
                    width: '5px', height: '5px',
                    borderRadius: '50%', background: '#14B8C8',
                  }} />
                ) : (
                  <div style={{
                    width: '4px', height: '4px',
                    borderRadius: '50%', background: 'rgba(255,255,255,0.15)',
                  }} />
                )}
              </div>

              {/* Label */}
              <span style={{
                fontSize:   '0.78rem',
                color:      done ? '#4A5E7A' : active ? '#E6EDF3' : '#2D3A4A',
                fontWeight: active ? 500 : 400,
              }}>
                {phase.label}
              </span>

              {/* Status badge */}
              {active && (
                <span style={{
                  marginLeft:    'auto',
                  fontSize:      '0.62rem', fontWeight: 700,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  color:         '#14B8C8',
                  animation:     'fade-up 0.25s ease',
                }}>
                  working…
                </span>
              )}
              {done && !isDone && phaseNum === currentPhase - 1 && (
                <span style={{
                  marginLeft:    'auto',
                  fontSize:      '0.62rem', fontWeight: 700,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  color:         '#3FB950',
                }}>
                  done ✓
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
