'use client';

import { useEffect, useRef, useState } from 'react';
import type { StudyQueueItem, QueueResponse, StudyScopeType } from '@/types';
import { simplifyExplanation } from '@/lib/explanations';
import { Icon, Kbd } from './ui';
import { useHighlightAndStrikeoutHandlers } from './useQuizState';
import type { HighlightRange } from './useQuizState';

interface Props {
  scope?: StudyScopeType;
  pdfId?: string;
  deckId?: string;
  examDate: string | null;
  onDone: () => void;
}

const QUALITY: Record<number, { label: string; color: string; dimColor: string }> = {
  1: { label: 'Again', color: 'var(--red)',   dimColor: 'var(--red-dim)' },
  2: { label: 'Hard',  color: 'var(--amber)', dimColor: 'var(--amber-dim)' },
  3: { label: 'Good',  color: 'var(--green)', dimColor: 'var(--green-dim)' },
  4: { label: 'Easy',  color: 'var(--accent)', dimColor: 'var(--accent-dim)' },
};

const MAX_REPLAYS_PER_QUESTION = 2;

type SessionQueueItem = StudyQueueItem & {
  _sessionId: string;
  _replayAttempt: number;
};

function buildSessionItem(item: StudyQueueItem, replayAttempt = 0): SessionQueueItem {
  return {
    ...item,
    _sessionId: `${item.id}:${replayAttempt}:${crypto.randomUUID()}`,
    _replayAttempt: replayAttempt,
  };
}

function queueUrl(scope: StudyScopeType, pdfId?: string, deckId?: string) {
  if (scope === 'library') return '/api/study/queue?scope=library';
  if (scope === 'deck' && deckId) return `/api/study/queue?scope=deck&id=${encodeURIComponent(deckId)}`;
  if (pdfId) return `/api/study/queue?pdfId=${encodeURIComponent(pdfId)}`;
  return null;
}

/** Extracts "Key distinction: ..." sentence, renders it first and bolded. */
function formatExplanation(text: string) {
  const kdMatch = text.match(/Key distinction:\s*(.+?)(?:[.!?](?:\s|$)|$)/i);
  if (kdMatch) {
    const keyDistinction = kdMatch[1]!.trim();
    const rest = text.replace(/Key distinction:\s*.+?(?:[.!?](?:\s|$)|$)/i, '').trim();
    return (
      <>
        <strong>{keyDistinction}.</strong>
        {rest ? <>{' '}{rest}</> : null}
      </>
    );
  }
  const match = text.match(/^(.+?[.!?])\s+([\s\S]+)/);
  if (!match) return <strong>{text}</strong>;
  return (
    <>
      <strong>{match[1]}</strong>{' '}{match[2]}
    </>
  );
}

/** Renders plain text with yellow highlight marks over given character ranges. */
function HighlightedText({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  if (!ranges.length) return <>{text}</>;

  // Sort and merge overlapping ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: HighlightRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  // Build interleaved plain / highlighted segments
  const segments: Array<{ text: string; highlighted: boolean }> = [];
  let pos = 0;
  for (const r of merged) {
    if (r.start > pos) segments.push({ text: text.slice(pos, r.start), highlighted: false });
    if (r.end > r.start) segments.push({ text: text.slice(r.start, r.end), highlighted: true });
    pos = r.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), highlighted: false });

  return (
    <>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark key={i} style={{
            background: 'rgba(234,179,8,0.28)',
            borderRadius: '2px',
            padding: '0 1px',
            color: 'inherit',
            boxDecorationBreak: 'clone',
            WebkitBoxDecorationBreak: 'clone',
          }}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </>
  );
}

export default function StudyView({ scope = 'pdf', pdfId, deckId, onDone }: Props) {
  const [queue,    setQueue]    = useState<SessionQueueItem[]>([]);
  const [idx,      setIdx]      = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [rated,    setRated]    = useState<Record<string, boolean>>({});
  const [loading,  setLoading]  = useState(true);
  const [correct,  setCorrect]  = useState(0);
  const [total,    setTotal]    = useState(0);
  const [streak,   setStreak]   = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [submittingQuality, setSubmittingQuality] = useState<number | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const replayCountsRef = useRef<Record<string, number>>({});
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = queue[idx];
  const { stemRef, currentHighlights, currentStrikeouts, handleStemMouseUp, clearHighlights, toggleStrikeout } = useHighlightAndStrikeoutHandlers({ idx, revealed });

  useEffect(() => {
    const url = queueUrl(scope, pdfId, deckId);
    if (!url) {
      setLoading(false);
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json() as Promise<QueueResponse>)
      .then(data => {
        setQueue(data.queue.map(item => buildSessionItem(item)));
        replayCountsRef.current = {};
        setRated({});
        setIdx(0);
        setSelected(null);
        setRevealed(false);
        setCorrect(0);
        setTotal(0);
        setStreak(0);
        setFocusMode(false);
        setSubmittingQuality(null);
        setQualityError(null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    return () => ctrl.abort();
  }, [deckId, pdfId, scope]);

  useEffect(() => {
    return () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    };
  }, []);

  function goForward() {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    setIdx(i => i + 1);
    setRevealed(false);
    setSelected(null);
    setSubmittingQuality(null);
    setQualityError(null);
  }

  function selectOption(optIdx: number) {
    if (revealed || !current || optIdx < 0 || optIdx >= current.options.length) return;
    setSelected(optIdx);
    setRevealed(true);
    setTotal(t => t + 1);
    if (optIdx === current.answer) setCorrect(c => c + 1);
  }

  async function rateQuality(quality: number) {
    if (!current || rated[current._sessionId] || submittingQuality !== null) return;

    const sessionId = current._sessionId;
    setSubmittingQuality(quality);
    setQualityError(null);
    setRated(prev => ({ ...prev, [sessionId]: true }));

    try {
      const res = await fetch('/api/study/submit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          questionId:    current.id,
          quality,
          pdfId:         current.pdf_id,
          proxiedFromId: current._proxiedFromId ?? null,
        }),
      });

      if (!res.ok) throw new Error('Failed to submit study review');

      setStreak(s => quality >= 3 ? s + 1 : 0);

      if (quality === 1) {
        const replayCount = replayCountsRef.current[current.id] ?? 0;
        if (replayCount < MAX_REPLAYS_PER_QUESTION) {
          const nextReplayAttempt = replayCount + 1;
          replayCountsRef.current[current.id] = nextReplayAttempt;
          setQueue(prevQueue => [
            ...prevQueue,
            buildSessionItem(current, nextReplayAttempt),
          ]);
        }
      }

      advanceTimerRef.current = setTimeout(() => {
        advanceTimerRef.current = null;
        goForward();
      }, 280);
    } catch {
      setRated(prev => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSubmittingQuality(null);
      setQualityError('Could not schedule. Try again.');
    }
  }

  function skipCurrent() {
    goForward();
  }

  /* keyboard shortcuts */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onDone();
        return;
      }
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFocusMode(f => !f);
        return;
      }
      if (!current) return;
      if ((e.key === 'Enter' || e.key === 'ArrowRight') && current && rated[current._sessionId]) {
        e.preventDefault();
        goForward();
        return;
      }

      const n = parseInt(e.key);
      if (!Number.isFinite(n) || n < 1 || n > 4) return;
      if (!revealed) {
        e.preventDefault();
        selectOption(n - 1);
      } else if (current && !rated[current._sessionId]) {
        e.preventDefault();
        void rateQuality(n);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* -- Loading -- */
  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '12px', animation: 'float 2s ease-in-out infinite' }}>
            💡
          </div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Building your queue...</p>
        </div>
      </div>
    );
  }

  /* -- Empty -- */
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

  /* -- Session complete -- */
  if (idx >= queue.length) {
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    return (
      <div style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'center', padding: '80px 20px' }}>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
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
  const acc = total > 0 ? Math.round((correct / total) * 100) : null;
  const displayExplanation = simplifyExplanation(current.explanation, current.options[current.answer] ?? '');

  return (
    <div style={{ height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {!focusMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', flexShrink: 0 }}>
          <button onClick={onDone} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 6px' }} onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')} onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}><Icon name="arrow_l" size={14} />Exit <Kbd>esc</Kbd></button>
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>Question {idx + 1} / {queue.length}</span>
          <div style={{ flex: 1 }} />
          {acc !== null && <QuizStat label="Accuracy" val={`${acc}%`} color={acc >= 70 ? 'var(--green)' : acc >= 50 ? 'var(--amber)' : 'var(--red)'} />}
          <QuizStat label="Streak" val={String(streak)} color={streak >= 3 ? 'var(--accent)' : undefined} />
          <button onClick={() => setFocusMode(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 'var(--r2)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-secondary)' }}><Icon name="eye" size={12} />Focus <Kbd>F</Kbd></button>
        </div>
      )}
      <div style={{ height: 2, background: 'var(--bg-sunken)', position: 'relative', flexShrink: 0 }}><div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${((idx + (revealed ? 1 : 0.5)) / queue.length) * 100}%`, background: 'var(--accent)', transition: 'width 0.3s' }} /></div>
      <div style={{ flex: 1, overflow: 'auto', padding: focusMode ? '72px 40px 120px' : '32px 40px' }}>
        <div style={{ maxWidth: revealed ? 1100 : 640, margin: '0 auto', display: 'flex', gap: revealed ? 48 : 0, alignItems: 'flex-start' }}>
          <div style={{ flex: '0 0 640px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, fontSize: 11, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', padding: '2px 8px', borderRadius: 99, color: 'var(--accent)', background: 'var(--accent-dim)' }}>L{current.level}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>{current._bucket.toUpperCase()}</span>
            </div>
            <p ref={stemRef} onMouseUp={handleStemMouseUp} style={{ fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.5, fontWeight: 400, letterSpacing: '-0.01em', color: 'var(--text-primary)', margin: '0 0 6px', userSelect: 'text', cursor: 'text' }}><HighlightedText text={current.stem} ranges={currentHighlights} /></p>
            <div style={{ minHeight: '22px', marginBottom: '12px' }}>{currentHighlights.length > 0 && <button onClick={clearHighlights} style={{ fontSize: '0.65rem', color: 'var(--amber)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.02em', opacity: 0.75, transition: 'opacity 0.15s' }} onMouseEnter={e => (e.currentTarget.style.opacity = '1')} onMouseLeave={e => (e.currentTarget.style.opacity = '0.75')}>× clear highlights</button>}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 28 }}>
              {current.options.map((opt, i) => {
                const isSelected = selected === i;
                const isAnswer = revealed && i === current.answer;
                const isWrong = revealed && isSelected && !isAnswer;
                const isStruck = !revealed && currentStrikeouts.has(i);
                let borderColor = 'var(--border)';
                let bg = 'var(--bg-raised)';
                let letterBg = 'var(--bg-sunken)';
                let letterClr = 'var(--text-dim)';
                if (isAnswer) { borderColor = 'var(--green)'; bg = 'var(--green-dim)'; letterBg = 'rgba(76,122,62,0.18)'; letterClr = 'var(--green)'; }
                else if (isWrong) { borderColor = 'var(--red)'; bg = 'var(--red-dim)'; letterBg = 'rgba(155,58,47,0.15)'; letterClr = 'var(--red)'; }
                else if (isSelected && !revealed) { borderColor = 'var(--accent)'; }
                return (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                    <button onClick={() => selectOption(i)} onContextMenu={e => toggleStrikeout(i, e)} disabled={revealed} title={!revealed ? 'Right-click or two-finger click to eliminate' : undefined} style={{ flex: 1, display: 'flex', gap: 14, alignItems: 'flex-start', padding: '14px 18px', background: bg, border: `1px solid ${borderColor}`, borderRadius: 'var(--r2)', cursor: revealed ? 'default' : 'pointer', textAlign: 'left', color: 'var(--text-primary)', opacity: isStruck ? 0.4 : 1, transition: 'all 0.15s', fontFamily: 'var(--font-sans)' }} onMouseEnter={e => { if (!revealed) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-primary)'; } }} onMouseLeave={e => { if (!revealed) { (e.currentTarget as HTMLButtonElement).style.borderColor = borderColor; } }}>
                      <span style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: letterClr, background: letterBg, textDecoration: isStruck ? 'line-through' : 'none' }}>{String.fromCharCode(65 + i)}</span>
                      <span style={{ fontSize: 15, lineHeight: 1.5, flex: 1, textDecoration: isStruck ? 'line-through' : 'none', color: isStruck ? 'var(--text-dim)' : 'var(--text-primary)' }}>{opt}</span>
                      {isAnswer && <Icon name="check" size={16} color="var(--green)" />}
                      {isWrong && <Icon name="x" size={16} color="var(--red)" />}
                    </button>
                    {!revealed && <button onClick={() => toggleStrikeout(i, { preventDefault: () => {} } as React.MouseEvent)} title="Eliminate" style={{ width: 32, background: 'transparent', border: `1px dashed var(--border)`, borderRadius: 'var(--r2)', cursor: 'pointer', color: isStruck ? 'var(--red)' : 'var(--text-disabled)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>✕</button>}
                  </div>
                );
              })}
            </div>
            {!revealed && <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--text-dim)' }}><span><Kbd>A</Kbd>–<Kbd>{String.fromCharCode(64 + current.options.length)}</Kbd> answer</span><span>· ✕ eliminate</span><span>· drag to highlight</span></div>}
            {revealed && <div style={{ marginTop: 20 }}><div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 10px', borderRadius: 99, color: isCorrect ? 'var(--green)' : 'var(--red)', background: isCorrect ? 'var(--green-dim)' : 'var(--red-dim)' }}><Icon name={isCorrect ? 'check' : 'x'} size={12} color={isCorrect ? 'var(--green)' : 'var(--red)'} />{isCorrect ? 'Correct' : 'Incorrect'}</div></div>}
          </div>
          <div style={{ display: revealed ? undefined : 'none', flex: '1 1 0', minWidth: 0, paddingTop: 38, opacity: revealed ? 1 : 0, pointerEvents: revealed ? 'auto' : 'none', transition: 'opacity 0.2s ease' }}>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--text-primary)', margin: '0 0 16px' }}>{formatExplanation(displayExplanation)}</p>
            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <div style={{ padding: '14px 18px', background: 'var(--bg-raised)', borderLeft: '3px solid var(--accent)', borderRadius: '0 6px 6px 0' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.12em', marginBottom: 8, textTransform: 'uppercase' }}>Source</div>
                <p style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>&ldquo;{current.source_quote}&rdquo;</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '14px 24px', background: 'var(--bg-raised)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexShrink: 0, position: 'relative' }}>
        {!revealed ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', position: 'absolute', left: 24 }}>Select an answer to reveal</span>
            <button onClick={skipCurrent} style={{ padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r2)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)', position: 'absolute', right: 24 }}>Skip →</button>
          </>
        ) : !rated[current._sessionId] ? (
          <>
            {qualityError && <span style={{ fontSize: 11, color: 'var(--red)', position: 'absolute', left: 24 }}>{qualityError}</span>}
            {[1, 2, 3, 4].map(quality => <QualityBtn key={quality} quality={quality} disabled={submittingQuality !== null} active={submittingQuality === quality} onClick={() => void rateQuality(quality)} />)}
          </>
        ) : (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--green)', position: 'absolute', left: 24 }}><Icon name="check" size={12} color="var(--green)" /> Scheduled</span>
            <button onClick={goForward} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--accent)', border: 'none', borderRadius: 'var(--r2)', cursor: 'pointer', color: 'var(--accent-ink)', fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{idx + 1 < queue.length ? 'Next' : 'See Results'}<Icon name="arrow_r" size={14} color="var(--accent-ink)" /><Kbd dim>↵</Kbd></button>
          </>
        )}
      </div>
    </div>
  );
}

function QuizStat({ label, val, color }: { label: string; val: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600, color: color ?? 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{val}</span>
    </div>
  );
}

function QualityBtn({
  quality,
  disabled,
  active,
  onClick,
}: {
  quality: number;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { label, color } = QUALITY[quality]!;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px',
        borderRadius: 'var(--r2)',
        fontSize: 13,
        fontWeight: 600,
        border: `1px solid ${color}`,
        background: hovered || active ? color : 'var(--bg-raised)',
        color: hovered || active ? '#fff' : color,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !active ? 0.6 : 1,
        fontFamily: 'var(--font-sans)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Kbd dim={hovered || active}>{quality}</Kbd>
      {label}
    </button>
  );
}
