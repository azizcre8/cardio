'use client';

import { useEffect, useRef, useState } from 'react';
import type { StudyQueueItem, QueueResponse } from '@/types';

interface Props {
  pdfId:    string;
  examDate: string | null;
  onDone:   () => void;
}

const QUALITY: Record<number, { label: string; sub: string }> = {
  1: { label: '✗ Wrong', sub: 'Again' },
  2: { label: '😅 Hard',  sub: 'Hard'  },
  3: { label: '✓ Good',  sub: 'Good'  },
  4: { label: '⚡ Easy', sub: 'Easy'  },
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

  const current = queue[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setSelected(optIdx);
    setRevealed(true);
    setTotal(t => t + 1);
    if (current && optIdx === current.answer) setCorrect(c => c + 1);
  }

  async function rateQuality(quality: number) {
    if (!current || rated[current.id]) return;
    setRated(prev => ({ ...prev, [current.id]: true }));
    await fetch('/api/study/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
    }, 350);
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-sm" style={{ color: 'var(--text-dim)' }}>Loading queue…</div>
      </div>
    );
  }

  /* ── Empty ── */
  if (!queue.length) {
    return (
      <div className="text-center py-24">
        <p className="mb-4 text-sm" style={{ color: 'var(--text-dim)' }}>No questions due right now.</p>
        <button
          onClick={onDone}
          className="text-sm font-semibold transition-colors"
          style={{ color: 'var(--accent)' }}
        >← Back to Library</button>
      </div>
    );
  }

  /* ── Session complete ── */
  if (idx >= queue.length) {
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return (
      <div className="max-w-md mx-auto text-center py-20">
        <div
          className="font-serif text-5xl font-light mb-2"
          style={{ color: 'var(--accent)', letterSpacing: '-0.04em' }}
        >
          {pct}%
        </div>
        <p className="text-sm mb-1 font-semibold" style={{ color: 'var(--text-primary)' }}>Session complete</p>
        <p className="text-xs mb-8" style={{ color: 'var(--text-dim)' }}>{correct}/{total} correct</p>
        <button
          onClick={onDone}
          className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white"
          style={{ background: 'var(--accent)' }}
        >
          Back to Library
        </button>
      </div>
    );
  }

  if (!current) return null;

  const isCorrect = selected === current.answer;

  return (
    <div className="max-w-2xl mx-auto">

      {/* ── Progress bar ── */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-sunken)' }}>
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${(idx / queue.length) * 100}%`, background: 'var(--accent)' }}
          />
        </div>
        <span className="text-xs tabular-nums" style={{ color: 'var(--text-dim)' }}>{idx + 1}/{queue.length}</span>
        <button
          onClick={onDone}
          className="text-xs transition-colors"
          style={{ color: 'var(--text-dim)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--red)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
        >✕</button>
      </div>

      {/* ── Level + bucket badges ── */}
      <div className="flex gap-2 mb-3">
        <span
          className="text-[0.62rem] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full"
          style={{ background: 'var(--accent-dim)', border: '1px solid rgba(13,154,170,0.2)', color: 'var(--accent)' }}
        >
          L{current.level}
        </span>
        <span
          className="text-[0.62rem] font-bold tracking-widest uppercase px-2 py-0.5 rounded-full"
          style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}
        >
          {current._bucket}
        </span>
      </div>

      {/* ── Question card ── */}
      <div
        className="rounded-2xl p-6 mb-5"
        style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
      >
        {/* Question stem */}
        <p
          className="leading-relaxed mb-5"
          style={{ fontSize: '1.05rem', fontWeight: 500, color: 'var(--text-primary)', letterSpacing: '-0.005em', lineHeight: 1.65 }}
        >
          {current.stem}
        </p>

        {/* ── 2×2 options grid ── */}
        <div className="grid grid-cols-2 gap-3">
          {current.options.map((opt, i) => {
            const isSelected = selected === i;
            const isAnswer   = revealed && i === current.answer;
            const isWrong    = revealed && isSelected && !isAnswer;

            let borderColor = 'var(--border)';
            let bg          = 'var(--bg)';
            let textColor   = 'var(--text-primary)';
            let letterBg    = 'rgba(0,0,0,0.04)';
            let letterBorder = 'var(--border-med)';
            let letterColor = 'var(--text-dim)';

            if (isAnswer) {
              borderColor  = 'rgba(22,163,74,0.5)';
              bg           = 'rgba(22,163,74,0.05)';
              letterBg     = 'rgba(22,163,74,0.12)';
              letterBorder = 'rgba(22,163,74,0.4)';
              letterColor  = '#16a34a';
            } else if (isWrong) {
              borderColor  = 'rgba(220,38,38,0.5)';
              bg           = 'rgba(220,38,38,0.05)';
              letterBg     = 'rgba(220,38,38,0.12)';
              letterBorder = 'rgba(220,38,38,0.4)';
              letterColor  = '#dc2626';
            } else if (revealed) {
              textColor = 'var(--text-dim)';
            }

            const xpl = current.option_explanations?.[i];
            const showXpl = revealed && (isSelected || isAnswer) && xpl;

            return (
              <div key={i} className="flex flex-col">
                <button
                  onClick={() => selectOption(i)}
                  disabled={revealed}
                  className="flex items-start gap-3 p-4 rounded-xl text-left transition-all w-full"
                  style={{
                    background:  bg,
                    border:     `1.5px solid ${borderColor}`,
                    color:       textColor,
                    cursor:      revealed ? 'default' : 'pointer',
                    minHeight:   '80px',
                  }}
                  onMouseEnter={e => {
                    if (!revealed) {
                      e.currentTarget.style.borderColor = 'var(--accent)';
                      e.currentTarget.style.boxShadow  = '0 0 0 2px var(--accent-glow)';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!revealed) {
                      e.currentTarget.style.borderColor = borderColor;
                      e.currentTarget.style.boxShadow  = 'none';
                    }
                  }}
                >
                  {/* Letter badge */}
                  <span
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
                    style={{ background: letterBg, border: `1.5px solid ${letterBorder}`, color: letterColor }}
                  >
                    {LETTERS[i]}
                  </span>
                  <span className="text-sm leading-snug flex-1" style={{ lineHeight: 1.5 }}>{opt}</span>
                  <span className="text-xs ml-auto flex-shrink-0 self-start" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>{i + 1}</span>
                </button>

                {/* Per-option explanation */}
                {showXpl && (
                  <div
                    className="mt-1 px-4 pt-2.5 pb-3 rounded-r-lg text-sm"
                    style={{
                      borderLeft:  `3px solid ${isAnswer ? '#16a34a' : '#dc2626'}`,
                      background:  isAnswer ? 'rgba(22,163,74,0.04)' : 'rgba(220,38,38,0.04)',
                      color:       'var(--text-primary)',
                      lineHeight:  1.6,
                    }}
                  >
                    <span
                      className="text-[0.68rem] font-bold tracking-wide uppercase block mb-1"
                      style={{ color: isAnswer ? '#16a34a' : '#dc2626' }}
                    >
                      {isAnswer ? '✓ Correct' : '✗ Your choice'} —
                    </span>
                    {xpl}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Hint before answering */}
        {!revealed && (
          <p className="text-xs text-center mt-4" style={{ color: 'var(--text-dim)' }}>
            Select an answer · keyboard <kbd className="px-1 py-0.5 rounded text-[0.6rem]" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>1</kbd>–<kbd className="px-1 py-0.5 rounded text-[0.6rem]" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>4</kbd>
          </p>
        )}
      </div>

      {/* ── Explanation + evidence (revealed) ── */}
      {revealed && (
        <div className="space-y-3 mb-4">
          {/* Main explanation */}
          <div
            className="rounded-xl p-5"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
          >
            <p
              className="text-xs font-bold tracking-widest uppercase mb-2"
              style={{ color: isCorrect ? '#16a34a' : '#dc2626' }}
            >
              {isCorrect ? '✓ Correct' : '✗ Incorrect'}
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)', lineHeight: 1.7 }}>
              {current.explanation}
            </p>
          </div>

          {/* Source quote / evidence box */}
          {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
            <div
              className="rounded-r-xl pl-4 pr-5 py-4"
              style={{
                background:  'var(--bg-sunken)',
                border:      '1px solid var(--border)',
                borderLeft:  '3px solid var(--accent)',
              }}
            >
              <p
                className="text-[0.62rem] font-bold tracking-widest uppercase mb-2"
                style={{ color: 'var(--accent)' }}
              >
                📑 Evidence from PDF
              </p>
              <p
                className="font-serif text-sm italic leading-relaxed"
                style={{ color: 'var(--text-primary)', fontWeight: 400, lineHeight: 1.65 }}
              >
                &ldquo;{current.source_quote}&rdquo;
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Quality rating buttons ── */}
      {revealed && !rated[current.id] && (
        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs text-center mb-3 font-medium" style={{ color: 'var(--text-dim)' }}>
            How well did you know this?
          </p>
          <div className="grid grid-cols-4 gap-2">
            {[1, 2, 3, 4].map(q => (
              <QualityBtn key={q} quality={q} onClick={() => rateQuality(q)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QualityBtn({ quality, onClick }: { quality: number; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  const { label } = QUALITY[quality];

  const accentMap: Record<number, string> = {
    1: '#dc2626',
    2: '#d97706',
    3: '#16a34a',
    4: 'var(--accent)',
  };
  const accent = accentMap[quality];

  return (
    <button
      onClick={onClick}
      className="py-2.5 rounded-lg text-xs font-semibold transition-all"
      style={{
        background:  hov ? accent : 'var(--bg-sunken)',
        border:      `1px solid ${hov ? accent : 'var(--border)'}`,
        color:       hov ? '#fff' : 'var(--text-secondary)',
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      {label}
    </button>
  );
}
