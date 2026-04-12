'use client';

import { useEffect, useState } from 'react';
import type { Question } from '@/types';

interface Props {
  pdfId:  string;
  onDone: () => void;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

export default function QuizView({ pdfId, onDone }: Props) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx,       setIdx]       = useState(0);
  const [revealed,  setRevealed]  = useState(false);
  const [selected,  setSelected]  = useState<number | null>(null);
  const [correct,   setCorrect]   = useState(0);
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(true);
  const [showQuote, setShowQuote] = useState(false);

  useEffect(() => {
    fetch(`/api/pdfs/${pdfId}/questions`)
      .then(r => r.json())
      .then(d => { setQuestions(d.questions ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [pdfId]);

  /* keyboard shortcuts */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const current = questions[idx];
      if (!current) return;
      const n = parseInt(e.key);
      if (!revealed && n >= 1 && n <= current.options.length) {
        selectOption(n - 1);
      } else if (revealed && e.key === 'Enter' || e.key === ' ') {
        advance();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const current = questions[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setSelected(optIdx);
    setRevealed(true);
    setShowQuote(false);
    setTotal(t => t + 1);
    if (current && optIdx === current.answer) setCorrect(c => c + 1);
  }

  function advance() {
    setIdx(i => i + 1);
    setRevealed(false);
    setSelected(null);
    setShowQuote(false);
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '96px 20px' }}>
        <div style={{ fontSize: '2rem', marginBottom: '12px', animation: 'float 2s ease-in-out infinite' }}>
          💡
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Loading questions…</p>
      </div>
    );
  }

  /* ── Empty ── */
  if (!questions.length) {
    return (
      <div style={{ textAlign: 'center', padding: '96px 20px' }}>
        <div style={{ fontSize: '2rem', marginBottom: '12px' }}>📭</div>
        <p style={{ marginBottom: '16px', fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
          No questions found in this bank.
        </p>
        <button
          onClick={onDone}
          style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          ← Back
        </button>
      </div>
    );
  }

  /* ── Session complete ── */
  if (idx >= questions.length) {
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return (
      <div style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'center', padding: '80px 20px' }}>
        <div style={{
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontSize: '4.5rem', fontWeight: 300,
          color: pct >= 80 ? 'var(--green)' : pct >= 60 ? 'var(--amber)' : 'var(--red)',
          letterSpacing: '-0.04em', lineHeight: 1, marginBottom: '10px',
          animation: 'fade-up 0.4s ease',
        }}>
          {pct}%
        </div>
        <p style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px', fontSize: '1rem' }}>
          Quiz complete
        </p>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '32px' }}>
          {correct} / {total} correct
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
          <button
            onClick={() => { setIdx(0); setCorrect(0); setTotal(0); setRevealed(false); setSelected(null); }}
            style={{
              padding: '10px 24px', borderRadius: 'var(--radius-md)',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Restart
          </button>
          <button
            onClick={onDone}
            style={{
              padding: '10px 24px', borderRadius: 'var(--radius-md)',
              background: 'var(--accent)', color: 'white',
              fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
            }}
          >
            Choose Another Bank
          </button>
        </div>
      </div>
    );
  }

  if (!current) return null;
  const isCorrect = selected === current.answer;

  return (
    <div style={{
      maxWidth:      '640px',
      margin:        '0 auto',
      minHeight:     'calc(100vh - 80px)',
      display:       'flex',
      flexDirection: 'column',
      paddingBottom: revealed ? '20px' : '0',
    }}>

      {/* Progress + close */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <div style={{ flex: 1, height: '3px', borderRadius: '2px', overflow: 'hidden', background: 'var(--bg-sunken)' }}>
          <div style={{
            height: '100%', borderRadius: '2px',
            width: `${(idx / questions.length) * 100}%`,
            background: 'var(--accent)', transition: 'width 0.3s ease',
          }} />
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {idx + 1} / {questions.length}
        </span>
        {total > 0 && (
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-dim)' }}>
            {Math.round((correct / total) * 100)}%
          </span>
        )}
        <button
          onClick={onDone}
          style={{
            fontSize: '0.85rem', color: 'var(--text-dim)',
            background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          ✕
        </button>
      </div>

      {/* Level badge */}
      <div style={{ marginBottom: '12px' }}>
        <span style={{
          fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: '99px',
          background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.22)',
          color: 'var(--accent)',
        }}>
          L{current.level}
        </span>
      </div>

      {/* Card */}
      <div style={{
        background: 'var(--bg-raised)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden', flex: 1,
      }}>
        <div style={{ padding: '20px 20px 0' }}>
          {/* Stem */}
          <p style={{
            fontSize: '1rem', fontWeight: 500, lineHeight: 1.65,
            color: 'var(--text-primary)', letterSpacing: '-0.005em',
            margin: '0 0 18px',
          }}>
            {current.stem}
          </p>

          {/* Options */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
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
                borderColor = 'rgba(22,163,74,0.5)'; bg = 'rgba(22,163,74,0.06)';
                letterBg = 'rgba(22,163,74,0.14)'; letterBdr = 'rgba(22,163,74,0.45)'; letterClr = 'var(--green)';
              } else if (isWrong) {
                borderColor = 'rgba(220,38,38,0.45)'; bg = 'rgba(220,38,38,0.05)';
                letterBg = 'rgba(220,38,38,0.12)'; letterBdr = 'rgba(220,38,38,0.4)'; letterClr = 'var(--red)';
              } else if (isDimmed) {
                textColor = 'var(--text-dim)';
              }

              return (
                <button
                  key={i}
                  onClick={() => selectOption(i)}
                  disabled={revealed}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: '10px',
                    padding: '11px 12px',
                    background: bg, border: `1.5px solid ${borderColor}`,
                    borderRadius: 'var(--radius-md)',
                    textAlign: 'left', cursor: revealed ? 'default' : 'pointer',
                    transition: 'all 0.15s ease', minHeight: '70px', color: textColor,
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

        {/* Revealed: explanation + next button */}
        {revealed && (
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--border)', marginTop: '4px' }}>
            <p style={{
              fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: isCorrect ? 'var(--green)' : 'var(--red)', marginBottom: '8px',
            }}>
              {isCorrect ? '✓ Correct' : '✗ Incorrect'}
            </p>

            <p style={{ fontSize: '0.84rem', lineHeight: 1.7, color: 'var(--text-primary)', marginBottom: '16px' }}>
              {current.explanation}
            </p>

            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <div style={{ marginBottom: '16px' }}>
                <button
                  onClick={() => setShowQuote(q => !q)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '5px',
                    fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.06em',
                    color: 'var(--accent)', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '0', textTransform: 'uppercase',
                  }}
                >
                  <span>{showQuote ? '▾' : '▸'}</span>
                  Source Evidence
                </button>
                {showQuote && (
                  <div style={{
                    marginTop: '8px', padding: '10px 14px',
                    background: 'var(--bg-sunken)', borderLeft: '3px solid var(--accent)',
                    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                    animation: 'fade-up 0.2s ease',
                  }}>
                    <p style={{
                      fontFamily: "'Source Serif 4', Georgia, serif",
                      fontSize: '0.8rem', fontStyle: 'italic',
                      color: 'var(--text-secondary)', lineHeight: 1.65, margin: 0,
                    }}>
                      &ldquo;{current.source_quote}&rdquo;
                    </p>
                    {current.concept_name && (
                      <p style={{
                        fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.03em',
                        color: 'var(--accent)', margin: '6px 0 0',
                        textTransform: 'none',
                      }}>
                        — {current.concept_name}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <button
              onClick={advance}
              style={{
                width: '100%', padding: '10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent)', color: 'white',
                fontSize: '0.85rem', fontWeight: 600, border: 'none', cursor: 'pointer',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              {idx + 1 < questions.length ? 'Next →' : 'See Results'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
