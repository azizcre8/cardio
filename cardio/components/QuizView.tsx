'use client';

import { useEffect, useRef, useState } from 'react';
import type { Question } from '@/types';

interface Props {
  pdfId:  string;
  onDone: () => void;
}

interface AnswerState {
  selected: number | null;
  revealed: boolean;
}

interface HighlightRange {
  start: number;
  end: number;
}

interface ValidationResult {
  loading: boolean;
  error: string | null;
  isValid: boolean | null;
  issues: string[];
  suggestedFix: string;
  confidence: 'high' | 'medium' | 'low' | null;
}

const QUALITY: Record<number, { label: string; color: string }> = {
  1: { label: '✗ Wrong', color: '#F85149' },
  2: { label: '😅 Hard', color: '#D29922' },
  3: { label: '✓ Good', color: '#3FB950' },
  4: { label: '⚡ Easy', color: '#14B8C8' },
};

/** Extracts "Key distinction: …" sentence, renders it first and bolded. */
function formatExplanation(text: string) {
  // Pull out the key-distinction clause wherever it sits in the text
  const kdMatch = text.match(/Key distinction:\s*(.+?)(?:[.!?](?:\s|$)|$)/i);
  if (kdMatch) {
    const keyDistinction = kdMatch[1]!.trim();
    // Remove the full "Key distinction: …[punctuation]" span from the rest
    const rest = text.replace(/Key distinction:\s*.+?(?:[.!?](?:\s|$)|$)/i, '').trim();
    return (
      <>
        <strong>{keyDistinction}.</strong>
        {rest ? <>{' '}{rest}</> : null}
      </>
    );
  }
  // Fallback: bold the first sentence
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

export default function QuizView({ pdfId, onDone }: Props) {
  const [questions,  setQuestions]  = useState<Question[]>([]);
  const [idx,        setIdx]        = useState(0);
  const [answers,    setAnswers]    = useState<AnswerState[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [rated,      setRated]      = useState<Record<number, boolean>>({});
  const [submittingQuality, setSubmittingQuality] = useState<number | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Map<number, HighlightRange[]>>(new Map());
  const [strikeouts, setStrikeouts] = useState<Map<number, Set<number>>>(new Map());
  const [validationByIdx, setValidationByIdx] = useState<Map<number, ValidationResult>>(new Map());
  const stemRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    fetch(`/api/pdfs/${pdfId}/questions`)
      .then(r => r.json())
      .then(d => {
        const qs: Question[] = d.questions ?? [];
        setQuestions(qs);
        setAnswers(qs.map(() => ({ selected: null, revealed: false })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [pdfId]);

  // Derived per-question state
  const ans      = answers[idx] ?? { selected: null, revealed: false };
  const selected = ans.selected;
  const revealed = ans.revealed;

  // Dynamically computed score (no double-counting on revisit)
  const total   = answers.filter(a => a.revealed).length;
  const correct = answers.filter((a, i) => a.revealed && a.selected === questions[i]?.answer).length;

  const currentHighlights = highlights.get(idx) ?? [];
  const currentStrikeouts = strikeouts.get(idx) ?? new Set<number>();

  /* keyboard shortcuts */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const current = questions[idx];
      if (!current) return;

        const n = parseInt(e.key);
        if (!revealed && n >= 1 && n <= current.options.length) {
          selectOption(n - 1);
        } else if (revealed && n >= 1 && n <= 4 && !rated[idx] && !submittingQuality) {
          void submitQuality(n);
        } else if (revealed && rated[idx] && (n >= 1 && n <= 4)) {
          if (idx < questions.length) goForward();
        } else if (e.key === 'ArrowRight' || (revealed && (e.key === 'Enter' || e.key === ' '))) {
        if (revealed && !rated[idx]) return;
        if (idx < questions.length) goForward();
        } else if (e.key === 'ArrowLeft') {
          goBack();
        }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const current = questions[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setQualityError(null);
    setAnswers(prev => prev.map((a, i) =>
      i === idx ? { selected: optIdx, revealed: true } : a
    ));
  }

  function goForward() {
    setIdx(i => i + 1);
  }

  function goBack() {
    if (idx > 0) setIdx(i => i - 1);
  }

  function restart() {
    setIdx(0);
    setAnswers(questions.map(() => ({ selected: null, revealed: false })));
    setRated({});
    setSubmittingQuality(null);
    setQualityError(null);
    setHighlights(new Map());
    setStrikeouts(new Map());
    setValidationByIdx(new Map());
  }

  function reviewMissed() {
    const wrongQs = questions.filter((_, i) => {
      const a = answers[i];
      const q = questions[i];
      return a != null && q != null && a.revealed && a.selected !== q.answer;
    });
    if (!wrongQs.length) return;
    setQuestions(wrongQs);
    setIdx(0);
    setAnswers(wrongQs.map(() => ({ selected: null, revealed: false })));
    setRated({});
    setSubmittingQuality(null);
    setQualityError(null);
    setHighlights(new Map());
    setStrikeouts(new Map());
  }

  async function submitQuality(quality: number) {
    if (!current || rated[idx] || submittingQuality !== null) return;

    setSubmittingQuality(quality);
    setQualityError(null);

    try {
      const res = await fetch('/api/study/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: current.id,
          quality,
          pdfId,
          proxiedFromId: null,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' ? data.error : 'Failed to save SRS review.'
        );
      }

      setRated(prev => ({ ...prev, [idx]: true }));
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'Failed to save SRS review.');
    } finally {
      setSubmittingQuality(null);
    }
  }

  /** Capture text selection within the stem and persist it as a highlight. */
  function handleStemMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !stemRef.current) return;

    const range = sel.getRangeAt(0);
    const selectedText = range.toString();
    if (!selectedText.length) return;
    if (!stemRef.current.contains(range.commonAncestorContainer)) return;

    // Compute start offset from beginning of stem text
    const preRange = range.cloneRange();
    preRange.selectNodeContents(stemRef.current);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end   = start + selectedText.length;

    setHighlights(prev => {
      const next = new Map(prev);
      const existing = next.get(idx) ?? [];
      next.set(idx, [...existing, { start, end }]);
      return next;
    });

    sel.removeAllRanges();
  }

  function clearHighlights() {
    setHighlights(prev => {
      const next = new Map(prev);
      next.delete(idx);
      return next;
    });
  }

  /** Two-finger click (right-click) on an option toggles its strikeout. */
  function toggleStrikeout(optIdx: number, e: React.MouseEvent) {
    e.preventDefault();
    if (revealed) return;
    setStrikeouts(prev => {
      const next = new Map(prev);
      const set  = new Set(next.get(idx) ?? []);
      if (set.has(optIdx)) {
        set.delete(optIdx);
      } else {
        set.add(optIdx);
      }
      next.set(idx, set);
      return next;
    });
  }

  async function validateCurrentQuestion() {
    if (!current) return;

    setValidationByIdx(prev => {
      const next = new Map(prev);
      next.set(idx, {
        loading: true,
        error: null,
        isValid: null,
        issues: [],
        suggestedFix: '',
        confidence: null,
      });
      return next;
    });

    try {
      const res = await fetch('/api/questions/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfId,
          questionId: current.id,
          stem: current.stem,
          options: current.options,
          answer: current.answer,
          explanation: current.explanation,
          sourceQuote: current.source_quote,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Validation failed.');

      setValidationByIdx(prev => {
        const next = new Map(prev);
        next.set(idx, {
          loading: false,
          error: null,
          isValid: Boolean(data?.isValid),
          issues: Array.isArray(data?.issues) ? data.issues.map((x: unknown) => String(x)) : [],
          suggestedFix: String(data?.suggestedFix ?? ''),
          confidence: (data?.confidence === 'high' || data?.confidence === 'medium' || data?.confidence === 'low')
            ? data.confidence
            : null,
        });
        return next;
      });
    } catch (err) {
      setValidationByIdx(prev => {
        const next = new Map(prev);
        next.set(idx, {
          loading: false,
          error: err instanceof Error ? err.message : 'Validation failed.',
          isValid: null,
          issues: [],
          suggestedFix: '',
          confidence: null,
        });
        return next;
      });
    }
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
    const pct      = total > 0 ? Math.round((correct / total) * 100) : 0;
    const wrongCount = answers.filter((a, i) => a != null && a.revealed && a.selected !== questions[i]?.answer).length;
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
          {/* Primary: review missed — only shown when there are wrong answers */}
          {wrongCount > 0 && (
            <button
              onClick={reviewMissed}
              style={{
                width: '100%', padding: '12px 24px', borderRadius: 'var(--radius-md)',
                background: 'var(--accent)', color: 'white',
                fontSize: '0.875rem', fontWeight: 600, border: 'none', cursor: 'pointer',
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              Review Missed ({wrongCount})
            </button>
          )}

          {/* Secondary row */}
          <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
            <button
              onClick={restart}
              style={{
                flex: 1, padding: '10px 16px', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
            >
              Restart
            </button>
            <button
              onClick={onDone}
              style={{
                flex: 1, padding: '10px 16px', borderRadius: 'var(--radius-md)',
                background: wrongCount > 0 ? 'var(--bg-raised)' : 'var(--accent)',
                border: wrongCount > 0 ? '1px solid var(--border)' : 'none',
                color: wrongCount > 0 ? 'var(--text-secondary)' : 'white',
                fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                transition: 'color 0.15s, opacity 0.15s',
              }}
              onMouseEnter={e => {
                if (wrongCount > 0) e.currentTarget.style.color = 'var(--text-primary)';
                else e.currentTarget.style.opacity = '0.88';
              }}
              onMouseLeave={e => {
                if (wrongCount > 0) e.currentTarget.style.color = 'var(--text-secondary)';
                else e.currentTarget.style.opacity = '1';
              }}
            >
              ← Back to Concepts
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) return null;
  const isCorrect = selected === current.answer;
  const validation = validationByIdx.get(idx);

  return (
    <div style={{
      maxWidth:      revealed ? '1100px' : '640px',
      margin:        '0 auto',
      minHeight:     'calc(100vh - 80px)',
      display:       'flex',
      flexDirection: 'column',
      paddingBottom: '20px',
      transition:    'max-width 0.25s ease',
    }}>

      {/* Progress + nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>

        {/* Back arrow — always present, dims when unavailable */}
        <button
          onClick={goBack}
          disabled={idx === 0}
          title="Previous question (←)"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', flexShrink: 0,
            borderRadius: 'var(--radius-sm)',
            background: 'none',
            border: '1px solid var(--border)',
            color: idx === 0 ? 'var(--border)' : 'var(--text-dim)',
            fontSize: '0.8rem', cursor: idx === 0 ? 'default' : 'pointer',
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { if (idx > 0) (e.currentTarget.style.color = 'var(--text-primary)'); }}
          onMouseLeave={e => { if (idx > 0) (e.currentTarget.style.color = 'var(--text-dim)'); }}
        >
          ←
        </button>

        <div style={{ flex: 1, height: '3px', borderRadius: '2px', overflow: 'hidden', background: 'var(--bg-sunken)' }}>
          <div style={{
            height: '100%', borderRadius: '2px',
            width: `${((idx + 1) / questions.length) * 100}%`,
            background: 'var(--accent)', transition: 'width 0.3s ease',
          }} />
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {idx + 1} / {questions.length}
        </span>

        {/* Forward arrow — always present, dims at last question */}
        <button
          onClick={goForward}
          disabled={idx >= questions.length - 1}
          title="Next question (→)"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '26px', height: '26px', flexShrink: 0,
            borderRadius: 'var(--radius-sm)',
            background: 'none',
            border: '1px solid var(--border)',
            color: idx >= questions.length - 1 ? 'var(--border)' : 'var(--text-dim)',
            fontSize: '0.8rem', cursor: idx >= questions.length - 1 ? 'default' : 'pointer',
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { if (idx < questions.length - 1) (e.currentTarget.style.color = 'var(--text-primary)'); }}
          onMouseLeave={e => { if (idx < questions.length - 1) (e.currentTarget.style.color = 'var(--text-dim)'); }}
        >
          →
        </button>

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

      {/* Two-column layout when revealed, single column otherwise */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: revealed ? '1fr 1fr' : '1fr',
        gap:                 '16px',
        flex:                1,
        alignItems:          'start',
        transition:          'grid-template-columns 0.25s ease',
      }}>

        {/* ── Left: Question card ── */}
        <div style={{
          background:   'var(--bg-raised)',
          border:       '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          overflow:     'hidden',
        }}>
          <div style={{ padding: '20px' }}>

            {/* Stem — select text to highlight */}
            <p
              ref={stemRef}
              onMouseUp={handleStemMouseUp}
              style={{
                fontSize: '1rem', fontWeight: 500, lineHeight: 1.65,
                color: 'var(--text-primary)', letterSpacing: '-0.005em',
                margin: '0 0 6px',
                userSelect: 'text',
                cursor: 'text',
              }}
            >
              <HighlightedText text={current.stem} ranges={currentHighlights} />
            </p>

            {/* Highlight controls — shown only when highlights exist */}
            <div style={{ minHeight: '22px', marginBottom: '12px' }}>
              {currentHighlights.length > 0 && (
                <button
                  onClick={clearHighlights}
                  style={{
                    fontSize: '0.65rem', color: 'var(--amber)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 0, letterSpacing: '0.02em',
                    opacity: 0.75, transition: 'opacity 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '0.75')}
                >
                  × clear highlights
                </button>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
              <button
                onClick={validateCurrentQuestion}
                disabled={validation?.loading}
                style={{
                  fontSize: '0.67rem',
                  padding: '4px 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'none',
                  color: 'var(--text-dim)',
                  cursor: validation?.loading ? 'default' : 'pointer',
                  opacity: validation?.loading ? 0.6 : 1,
                }}
              >
                {validation?.loading ? 'Validating…' : 'Validate question'}
              </button>
            </div>

            {validation && !validation.loading && (
              <div style={{
                marginBottom: '12px',
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${validation.error
                  ? 'rgba(220,38,38,0.35)'
                  : validation.isValid
                    ? 'rgba(22,163,74,0.32)'
                    : 'rgba(245,158,11,0.35)'}`,
                background: 'var(--bg-sunken)',
              }}>
                {validation.error ? (
                  <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--red)' }}>{validation.error}</p>
                ) : (
                  <>
                    <p style={{
                      margin: '0 0 6px',
                      fontSize: '0.73rem',
                      fontWeight: 700,
                      color: validation.isValid ? 'var(--green)' : 'var(--amber)',
                    }}>
                      {validation.isValid ? 'Looks good' : 'Needs revision'}
                      {validation.confidence ? ` · ${validation.confidence} confidence` : ''}
                    </p>
                    {validation.issues.length > 0 && (
                      <ul style={{ margin: '0 0 6px', paddingLeft: '18px', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                        {validation.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {validation.suggestedFix && (
                      <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                        Suggested fix: {validation.suggestedFix}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Options */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {current.options.map((opt, i) => {
                const isSelected  = selected === i;
                const isAnswer    = revealed && i === current.answer;
                const isWrong     = revealed && isSelected && !isAnswer;
                const isDimmed    = revealed && !isSelected && !isAnswer;
                const isStruck    = !revealed && currentStrikeouts.has(i);

                let borderColor = 'var(--border)';
                let bg          = 'var(--bg)';
                let letterBg    = 'rgba(0,0,0,0.04)';
                let letterBdr   = 'var(--border-med)';
                let letterClr   = 'var(--text-dim)';
                let textColor   = 'var(--text-primary)';

                if (isAnswer) {
                  borderColor = 'rgba(22,163,74,0.5)';  bg = 'rgba(22,163,74,0.06)';
                  letterBg = 'rgba(22,163,74,0.14)'; letterBdr = 'rgba(22,163,74,0.45)'; letterClr = 'var(--green)';
                } else if (isWrong) {
                  borderColor = 'rgba(220,38,38,0.45)'; bg = 'rgba(220,38,38,0.05)';
                  letterBg = 'rgba(220,38,38,0.12)'; letterBdr = 'rgba(220,38,38,0.4)';  letterClr = 'var(--red)';
                } else if (isDimmed) {
                  textColor = 'var(--text-dim)';
                }

                return (
                  <button
                    key={i}
                    onClick={() => selectOption(i)}
                    onContextMenu={e => toggleStrikeout(i, e)}
                    disabled={revealed}
                    title={!revealed ? 'Two-finger click to eliminate' : undefined}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: '10px',
                      padding: '11px 12px',
                      background: bg, border: `1.5px solid ${borderColor}`,
                      borderRadius: 'var(--radius-md)',
                      textAlign: 'left', cursor: revealed ? 'default' : 'pointer',
                      transition: 'all 0.15s ease', minHeight: '70px', color: textColor,
                      opacity: isStruck ? 0.45 : 1,
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
                      position: 'relative',
                    }}>
                      {i + 1}
                      {/* Diagonal strikeout line over the badge */}
                      {isStruck && (
                        <span style={{
                          position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden',
                          pointerEvents: 'none',
                        }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" style={{ position: 'absolute', top: 0, left: 0 }}>
                            <line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <span style={{
                      fontSize: '0.82rem', lineHeight: 1.5,
                      textDecoration: isStruck ? 'line-through' : 'none',
                    }}>
                      {opt}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Pre-answer hint */}
            {!revealed && (
              <p style={{ fontSize: '0.72rem', textAlign: 'center', color: 'var(--text-dim)', padding: '14px 0 16px' }}>
                Select answer · keys{' '}
                <kbd style={{ padding: '1px 5px', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>1</kbd>
                –
                <kbd style={{ padding: '1px 5px', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>{current.options.length}</kbd>
                {' · '}drag to highlight{' · '}two-finger click to eliminate
                {idx > 0 && (
                  <>
                    {' · '}
                    <kbd style={{ padding: '1px 5px', borderRadius: '4px', fontSize: '0.65rem', background: 'var(--bg-sunken)', border: '1px solid var(--border)' }}>←</kbd>
                    {' '}prev
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {/* ── Right: Explanation panel (auto-shown on answer) ── */}
        {revealed && (
          <div style={{
            background:    'var(--bg-raised)',
            border:        '1px solid var(--border)',
            borderRadius:  'var(--radius-lg)',
            padding:       '20px',
            display:       'flex',
            flexDirection: 'column',
            gap:           '14px',
            animation:     'fade-up 0.22s ease',
          }}>
            {/* Correct / incorrect label */}
            <p style={{
              fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: isCorrect ? 'var(--green)' : 'var(--red)', margin: 0,
            }}>
              {isCorrect ? '✓ Correct' : '✗ Incorrect'}
            </p>

            {/* Explanation — first sentence bolded as key distinction */}
            <p style={{ fontSize: '0.84rem', lineHeight: 1.7, color: 'var(--text-primary)', margin: 0 }}>
              {formatExplanation(current.explanation)}
            </p>

            {/* Source evidence — auto-shown */}
            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <div>
                <p style={{
                  fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: 'var(--accent)', margin: '0 0 6px',
                }}>
                  Source Evidence
                </p>
                <div style={{
                  padding: '10px 14px',
                  background: 'var(--bg-sunken)', borderLeft: '3px solid var(--accent)',
                  borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
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
                    }}>
                      — {current.concept_name}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Navigation: prev + next */}
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {!rated[idx] && (
                <>
                  <p style={{
                    margin: 0,
                    fontSize: '0.68rem',
                    textAlign: 'center',
                    color: 'var(--text-dim)',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}>
                    Rate this for SRS
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                    {[1, 2, 3, 4].map(quality => (
                      <QualityBtn
                        key={quality}
                        quality={quality}
                        disabled={submittingQuality !== null}
                        active={submittingQuality === quality}
                        onClick={() => void submitQuality(quality)}
                      />
                    ))}
                  </div>
                  {qualityError && (
                    <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--red)', textAlign: 'center' }}>
                      {qualityError}
                    </p>
                  )}
                </>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
              {idx > 0 && (
                <button
                  onClick={goBack}
                  style={{
                    flex: '0 0 auto',
                    padding: '10px 16px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                    fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--bg-raised)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'var(--bg-sunken)';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }}
                >
                  ← Prev
                </button>
              )}
              <button
                onClick={goForward}
                disabled={!rated[idx]}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: 'var(--radius-md)',
                  background: !rated[idx] ? 'var(--bg-sunken)' : 'var(--accent)',
                  color: !rated[idx] ? 'var(--text-dim)' : 'white',
                  fontSize: '0.85rem', fontWeight: 600,
                  border: !rated[idx] ? '1px solid var(--border)' : 'none',
                  cursor: !rated[idx] ? 'default' : 'pointer',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => {
                  if (rated[idx]) e.currentTarget.style.opacity = '0.88';
                }}
                onMouseLeave={e => {
                  if (rated[idx]) e.currentTarget.style.opacity = '1';
                }}
              >
                {!rated[idx]
                  ? 'Choose SRS rating'
                  : idx + 1 < questions.length ? 'Next →' : 'See Results'}
              </button>
              </div>
            </div>
          </div>
        )}
      </div>
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
        padding: '9px 8px',
        borderRadius: 'var(--radius-md)',
        fontSize: '0.78rem',
        fontWeight: 600,
        border: `1px solid ${hovered || active ? color : 'var(--border)'}`,
        background: hovered || active ? color : 'var(--bg-raised)',
        color: hovered || active ? '#fff' : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !active ? 0.6 : 1,
        transition: 'all 0.15s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{
        fontSize: '0.65rem',
        fontWeight: 700,
        opacity: 0.6,
        background: hovered || active ? 'rgba(255,255,255,0.25)' : 'var(--bg-sunken)',
        borderRadius: '3px',
        padding: '1px 4px',
        lineHeight: 1.4,
      }}>{quality}</span>
      {label}
    </button>
  );
}
