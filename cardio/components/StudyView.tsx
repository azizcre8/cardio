'use client';

import { useEffect, useRef, useState } from 'react';
import type { StudyQueueItem, QueueResponse } from '@/types';

interface Props {
  pdfId:    string;
  examDate: string | null;
  onDone:   () => void;
}

const QUALITY: Record<number, { label: string; color: string }> = {
  1: { label: '✗ Wrong',  color: '#F85149' },
  2: { label: '😅 Hard',  color: '#D29922' },
  3: { label: '✓ Good',   color: '#3FB950' },
  4: { label: '⚡ Easy',  color: '#14B8C8' },
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

export default function StudyView({ pdfId, examDate, onDone }: Props) {
  const [queue,    setQueue]    = useState<StudyQueueItem[]>([]);
  const [idx,      setIdx]      = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [rated,    setRated]    = useState<Record<string, boolean>>({});
  const [loading,  setLoading]  = useState(true);
  const [correct,  setCorrect]  = useState(0);
  const [total,    setTotal]    = useState(0);
  const [showQuote, setShowQuote] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetch(`/api/study/queue?pdfId=${pdfId}`, { signal: ctrl.signal })
      .then(r => r.json() as Promise<QueueResponse>)
      .then(data => { setQueue(data.queue); setLoading(false); })
      .catch(() => setLoading(false));
    return () => ctrl.abort();
  }, [pdfId]);

  /* keyboard shortcuts */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const n = parseInt(e.key);
      if (!revealed) {
        if (n >= 1 && n <= 4) selectOption(n - 1);
      } else {
        const current = queue[idx];
        if (n >= 1 && n <= 4 && current && !rated[current.id]) rateQuality(n);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const current = queue[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setSelected(optIdx);
    setRevealed(true);
    setShowQuote(false);
    setTotal(t => t + 1);
    if (current && optIdx === current.answer) setCorrect(c => c + 1);
  }

  async function rateQuality(quality: number) {
    if (!current || rated[current.id]) return;
    setRated(prev => ({ ...prev, [current.id]: true }));
    await fetch('/api/study/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        questionId:    current.id,
        quality,
        pdfId,
        proxiedFromId: current._proxiedFromId ?? null,
      }),
    });
    setTimeout(() => {
      setIdx(i => i + 1);
      setRevealed(false);
      setSelected(null);
      setShowQuote(false);
    }, 280);
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '12px', animation: 'float 2s ease-in-out infinite' }}>
            💡
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Building your queue…</p>
        </div>
      </div>
    );
  }

  /* ── Empty ── */
  if (!queue.length) {
    return (
      <div style={{ textAlign: 'center', padding: '96px 20px' }}>
        <div style={{ fontSize: '2rem', marginBottom: '12px' }}>✅</div>
        <p style={{ marginBottom: '16px', fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
          All caught up — no cards due.
        </p>
        <button
          onClick={onDone}
          style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          ← Back to Library
        </button>
      </div>
    );
  }

  /* ── Session complete ── */
  if (idx >= queue.length) {
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return (
      <div style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'center', padding: '80px 20px' }}>
        <div
          style={{
            fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: '4.5rem', fontWeight: 300,
            color: pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)',
            letterSpacing: '-0.04em', lineHeight: 1, marginBottom: '10px',
            animation: 'fade-up 0.4s ease',
          }}
        >
          {pct}%
        </div>
        <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px', fontSize: '1rem' }}>
          Session complete
        </p>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '32px' }}>
          {correct}/{total} correct
        </p>
        <button
          onClick={onDone}
          style={{
            padding: '10px 32px', borderRadius: 'var(--radius-md)',
            background: 'var(--accent)', color: 'white',
            fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
          }}
        >
          Back to Library
        </button>
      </div>
    );
  }

  if (!current) return null;

  const isCorrect = selected === current.answer;

  return (
    /* Full-height flex column so quality bar can stick to bottom */
    <div style={{
      maxWidth:      '640px',
      margin:        '0 auto',
      minHeight:     'calc(100vh - 80px)',
      display:       'flex',
      flexDirection: 'column',
      paddingBottom: revealed ? '88px' : '0', /* make room for sticky quality bar */
    }}>

      {/* ── Progress bar + meta ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <div style={{ flex: 1, height: '3px', borderRadius: '2px', overflow: 'hidden', background: 'var(--bg-sunken)' }}>
          <div
            style={{
              height: '100%', borderRadius: '2px',
              width: `${(idx / queue.length) * 100}%`,
              background: 'var(--accent)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', tabularNums: true } as React.CSSProperties}>
          {idx + 1}/{queue.length}
        </span>
        {total > 0 && (
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: isCorrect ? 'var(--green)' : 'var(--text-dim)' }}>
            {Math.round((correct / total) * 100)}%
          </span>
        )}
        <button
          onClick={onDone}
          style={{
            fontSize: '0.85rem', color: 'var(--text-dim)', background: 'none',
            border: 'none', cursor: 'pointer', transition: 'color 0.15s', lineHeight: 1,
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          ✕
        </button>
      </div>

      {/* ── Level + bucket badges ── */}
      <div style={{ display: 'flex', gap: '7px', marginBottom: '12px' }}>
        <Badge text={`L${current.level}`} accent />
        <Badge text={current._bucket} />
      </div>

      {/* ── Main card ── */}
      <div
        style={{
          background:   'var(--bg-raised)',
          border:       '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow:     'hidden',
          flex:         1,
        }}
      >
        <div style={{ padding: '20px 20px 0' }}>
          {/* Question stem */}
          <p style={{
            fontSize:      '1rem', fontWeight: 500, lineHeight: 1.65,
            color:         'var(--text-primary)', letterSpacing: '-0.005em',
            marginBottom:  '18px', margin: '0 0 18px',
          }}>
            {current.stem}
          </p>

          {/* Options grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '0' }}>
            {current.options.map((opt, i) => {
              const isSelected = selected === i;
              const isAnswer   = revealed && i === current.answer;
              const isWrong    = revealed && isSelected && !isAnswer;
              const isDimmed   = revealed && !isSelected && !isAnswer;

              let borderColor = 'var(--border)';
              let bg          = 'var(--bg)';
              let letterBg    = 'rgba(0,0,0,0.04)';
              let letterBdr   = 'var(--border-med)';
              let letterClr   = 'var(--text-dim)';
              let textColor   = 'var(--text-primary)';

              if (isAnswer) {
                borderColor = 'rgba(22,163,74,0.5)';
                bg          = 'rgba(22,163,74,0.06)';
                letterBg    = 'rgba(22,163,74,0.14)';
                letterBdr   = 'rgba(22,163,74,0.45)';
                letterClr   = 'var(--green)';
              } else if (isWrong) {
                borderColor = 'rgba(220,38,38,0.45)';
                bg          = 'rgba(220,38,38,0.05)';
                letterBg    = 'rgba(220,38,38,0.12)';
                letterBdr   = 'rgba(220,38,38,0.4)';
                letterClr   = 'var(--red)';
              } else if (isDimmed) {
                textColor = 'var(--text-dim)';
              }

              return (
                <button
                  key={i}
                  onClick={() => selectOption(i)}
                  disabled={revealed}
                  style={{
                    display:     'flex', alignItems: 'flex-start', gap: '10px',
                    padding:     '11px 12px',
                    background:  bg, border: `1.5px solid ${borderColor}`,
                    borderRadius: 'var(--radius-md)',
                    textAlign:   'left', cursor: revealed ? 'default' : 'pointer',
                    transition:  'all 0.15s ease',
                    minHeight:   '70px',
                    color:       textColor,
                  }}
                  onMouseEnter={e => {
                    if (!revealed) {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow   = '0 0 0 2px var(--accent-glow)';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!revealed) {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = borderColor;
                      (e.currentTarget as HTMLButtonElement).style.boxShadow   = 'none';
                    }
                  }}
                >
                  <span style={{
                    width: '24px', height: '24px', borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 700,
                    background: letterBg, border: `1.5px solid ${letterBdr}`, color: letterClr,
                  }}>
                    {LETTERS[i]}
                  </span>
                  <span style={{ fontSize: '0.82rem', lineHeight: 1.5 }}>{opt}</span>
                </button>
              );
            })}
          </div>

          {/* Pre-answer hint */}
          {!revealed && (
            <p style={{ fontSize: '0.72rem', textAlign: 'center', color: 'var(--text-dim)', padding: '14px 0 16px' }}>
              Select an answer · keys{' '}
              <kbd style={{ padding: '1px 5px', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>1</kbd>
              –
              <kbd style={{ padding: '1px 5px', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>4</kbd>
            </p>
          )}
        </div>

        {/* ── Revealed: explanation area ── */}
        {revealed && (
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--border)', marginTop: '4px' }}>
            {/* Verdict */}
            <p style={{
              fontSize: '0.7rem', fontWeight: 800,
              letterSpacing: '0.08em', textTransform: 'uppercase',
              color: isCorrect ? 'var(--green)' : 'var(--red)',
              marginBottom: '8px',
            }}>
              {isCorrect ? '✓ Correct' : '✗ Incorrect'}
            </p>

            {/* Explanation */}
            <p style={{
              fontSize: '0.84rem', lineHeight: 1.7,
              color: 'var(--text-primary)', marginBottom: '0',
            }}>
              {current.explanation}
            </p>

            {/* Source quote (collapsed by default) */}
            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <div style={{ marginTop: '12px' }}>
                <button
                  onClick={() => setShowQuote(q => !q)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.06em',
                    color: 'var(--accent)', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '0',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>{showQuote ? '▾' : '▸'}</span>
                  📑 Source evidence
                </button>
                {showQuote && (
                  <div style={{
                    marginTop: '8px',
                    padding: '10px 14px',
                    background: 'var(--bg-sunken)',
                    borderLeft: '3px solid var(--accent)',
                    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                    animation: 'fade-up 0.2s ease',
                  }}>
                    <p style={{
                      fontFamily: "'Source Serif 4', Georgia, serif",
                      fontSize: '0.8rem', fontStyle: 'italic',
                      color: 'var(--text-secondary)', lineHeight: 1.65,
                      margin: 0,
                    }}>
                      &ldquo;{current.source_quote}&rdquo;
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sticky quality bar ── */}
      {revealed && !rated[current.id] && (
        <div style={{
          position:   'sticky',
          bottom:     0,
          left:       0, right: 0,
          background: 'var(--bg)',
          borderTop:  '1px solid var(--border)',
          padding:    '14px 0 18px',
          zIndex:     20,
        }}>
          <p style={{
            fontSize: '0.68rem', textAlign: 'center',
            color: 'var(--text-dim)', fontWeight: 500,
            marginBottom: '10px',
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}>
            How well did you know this?
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
            {[1, 2, 3, 4].map(q => (
              <QualityBtn
                key={q}
                quality={q}
                onClick={() => rateQuality(q)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({ text, accent }: { text: string; accent?: boolean }) {
  return (
    <span style={{
      fontSize: '0.6rem', fontWeight: 800,
      letterSpacing: '0.1em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: '99px',
      background:  accent ? 'var(--accent-dim)' : 'var(--bg-sunken)',
      border:      `1px solid ${accent ? 'rgba(13,154,170,0.22)' : 'var(--border)'}`,
      color:       accent ? 'var(--accent)' : 'var(--text-dim)',
    }}>
      {text}
    </span>
  );
}

function QualityBtn({ quality, onClick }: { quality: number; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  const { label, color } = QUALITY[quality as keyof typeof QUALITY]!;

  return (
    <button
      onClick={onClick}
      style={{
        padding:    '9px 8px',
        borderRadius: 'var(--radius-md)',
        fontSize:   '0.78rem', fontWeight: 600,
        border:     `1px solid ${hov ? color : 'var(--border)'}`,
        background: hov ? color : 'var(--bg-raised)',
        color:      hov ? '#fff' : 'var(--text-secondary)',
        cursor:     'pointer', transition: 'all 0.15s ease',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {label}
    </button>
  );
}
