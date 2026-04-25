'use client';

import { useEffect, useRef, useState } from 'react';
import type { AttemptFlagReason, Question } from '@/types';
import { Icon, Kbd } from './ui';

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

const QUALITY: Record<number, { label: string; color: string; dimColor: string }> = {
  1: { label: 'Again', color: 'var(--red)',   dimColor: 'var(--red-dim)' },
  2: { label: 'Hard',  color: 'var(--amber)', dimColor: 'var(--amber-dim)' },
  3: { label: 'Good',  color: 'var(--green)', dimColor: 'var(--green-dim)' },
  4: { label: 'Easy',  color: 'var(--accent)',dimColor: 'var(--accent-dim)' },
};

const LEVEL_LABEL: Record<number, string> = {
  1: 'RECALL',
  2: 'APPLICATION',
  3: 'REASONING',
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
  const [focusMode,  setFocusMode]  = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [streak,     setStreak]     = useState(0);
  const [elapsed,    setElapsed]    = useState(0);
  const startRef = useRef<number>(Date.now());
  const stemRef = useRef<HTMLParagraphElement>(null);

  // ── Question analytics state ──
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const [flagByIdx,     setFlagByIdx]     = useState<Map<number, AttemptFlagReason>>(new Map());
  const [helpfulByIdx,  setHelpfulByIdx]  = useState<Map<number, boolean>>(new Map());
  const [flagDropOpen,  setFlagDropOpen]  = useState(false);

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

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') { if (focusMode) setFocusMode(false); else onDone(); return; }
      if (e.key === 'f' || e.key === 'F') { setFocusMode(m => !m); return; }
      if (e.key === ' ' && revealed) { e.preventDefault(); setShowEvidence(s => !s); return; }

      const n = parseInt(e.key);
      if (!revealed && n >= 1 && n <= current.options.length) {
        selectOption(n - 1);
      } else if (revealed && n >= 1 && n <= 4 && !rated[idx] && !submittingQuality) {
        void submitQuality(n);
      } else if (revealed && rated[idx] && (n >= 1 && n <= 4)) {
        if (idx < questions.length) goForward();
      } else if (e.key === 'ArrowRight' || (revealed && e.key === 'Enter')) {
        if (revealed && !rated[idx]) return;
        if (idx < questions.length) goForward();
      } else if (e.key === 'ArrowLeft') {
        goBack();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Reset per-question analytics state when navigating to a new question
  useEffect(() => {
    setQuestionStartTime(Date.now());
    setFlagDropOpen(false);
  }, [idx]);

  const current = questions[idx];

  function selectOption(optIdx: number) {
    if (revealed) return;
    setQualityError(null);
    setShowEvidence(false);
    const q = questions[idx];
    if (q) {
      if (optIdx === q.answer) { setStreak(s => s + 1); }
      else setStreak(0);
    }
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
    setFlagByIdx(new Map());
    setHelpfulByIdx(new Map());
    setFlagDropOpen(false);
    setQuestionStartTime(Date.now());
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
    setFlagByIdx(new Map());
    setHelpfulByIdx(new Map());
    setFlagDropOpen(false);
    setQuestionStartTime(Date.now());
  }

  async function submitQuality(quality: number) {
    if (!current || rated[idx] || submittingQuality !== null) return;

    setSubmittingQuality(quality);
    setQualityError(null);

    try {
      // Fire analytics attempt (fire-and-forget, non-blocking)
      const timeSpentMs = Date.now() - questionStartTime;
      fireAttempt({
        questionId: current.id,
        pdfId,
        selectedOption: selected ?? -1,
        isCorrect: selected === current.answer,
        timeSpentMs,
        explanationHelpful: helpfulByIdx.get(idx) ?? null,
        flagReason: flagByIdx.get(idx) ?? null,
      });

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
      goForward();
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

  function fireAttempt(opts: {
    questionId: string;
    pdfId: string;
    selectedOption: number;
    isCorrect: boolean;
    timeSpentMs: number;
    explanationHelpful?: boolean | null;
    flagReason?: AttemptFlagReason | null;
  }) {
    void fetch('/api/questions/attempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...opts, source: 'quiz' }),
    }).catch(() => {});
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
          fontFamily: 'var(--font-serif)',
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
  const acc = total > 0 ? Math.round((correct / total) * 100) : null;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div style={{
      height: 'calc(100vh - 56px)',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg)',
    }}>

      {/* Top rail */}
      {!focusMode && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '10px 24px', borderBottom: '1px solid var(--border)',
          background: 'var(--bg)', flexShrink: 0,
        }}>
          <button
            onClick={onDone}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: 'none',
              fontFamily: 'var(--font-sans)', fontSize: 12,
              color: 'var(--text-secondary)', cursor: 'pointer', padding: '4px 6px',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
          >
            <Icon name="arrow_l" size={14} />Exit <Kbd>esc</Kbd>
          </button>

          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
            Question {idx + 1} / {questions.length}
          </span>

          <div style={{ flex: 1 }} />

          {acc !== null && (
            <QuizStat label="Accuracy" val={`${acc}%`} color={acc >= 70 ? 'var(--green)' : acc >= 50 ? 'var(--amber)' : 'var(--red)'} />
          )}
          <QuizStat label="Streak" val={String(streak)} color={streak >= 3 ? 'var(--accent)' : undefined} />
          <QuizStat label="Time" val={`${mm}:${ss}`} />

          <button
            onClick={() => setFocusMode(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', background: 'var(--bg-raised)',
              border: '1px solid var(--border)', borderRadius: 'var(--r2)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              fontSize: 11, color: 'var(--text-secondary)',
            }}
          >
            <Icon name="eye" size={12} />Focus <Kbd>F</Kbd>
          </button>
        </div>
      )}

      {/* Progress bar */}
      <div style={{ height: 2, background: 'var(--bg-sunken)', position: 'relative', flexShrink: 0 }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${((idx + (revealed ? 1 : 0.5)) / questions.length) * 100}%`,
          background: 'var(--accent)', transition: 'width 0.3s',
        }} />
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflow: 'auto', padding: focusMode ? '72px 40px 120px' : '32px 40px' }}>
        <div style={{
          maxWidth: 1100,
          margin: '0 auto',
          display: 'flex',
          gap: 48,
          alignItems: 'flex-start',
        }}>

          {/* ── Left column: question ── */}
          <div style={{ flex: '0 0 640px', minWidth: 0 }}>

            {/* Meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, fontSize: 11, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                padding: '2px 8px', borderRadius: 99,
                color: 'var(--accent)', background: 'var(--accent-dim)',
              }}>
                L{current.level} · {LEVEL_LABEL[current.level] ?? 'QUESTION'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.04em' }}>
                {current.concept_name ? current.concept_name.toUpperCase() : ''}
              </span>
            </div>

            {/* Stem — select text to highlight */}
            <p
              ref={stemRef}
              onMouseUp={handleStemMouseUp}
              style={{
                fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.5,
                fontWeight: 400, letterSpacing: '-0.01em',
                color: 'var(--text-primary)', margin: '0 0 6px',
                userSelect: 'text', cursor: 'text',
              }}
            >
              <HighlightedText text={current.stem} ranges={currentHighlights} />
            </p>

            {/* Highlight controls */}
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
                  display: 'flex', alignItems: 'center', gap: 5,
                  fontSize: '0.67rem',
                  padding: '4px 10px',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'none',
                  color: 'var(--text-dim)',
                  cursor: validation?.loading ? 'default' : 'pointer',
                  opacity: validation?.loading ? 0.6 : 1,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {validation?.loading ? (
                  <>
                    <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: '0.6rem' }}>⟳</span>
                    Checking…
                  </>
                ) : (
                  <>✓ Fact check</>
                )}
              </button>
            </div>

            {validation && !validation.loading && (
              <div style={{
                marginBottom: '12px',
                padding: '10px 14px',
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
                      {validation.isValid ? '✓ Factually verified against source' : '⚠ Factual issues found'}
                      {validation.confidence ? <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> · {validation.confidence} confidence</span> : ''}
                    </p>
                    {validation.issues.length > 0 && (
                      <ul style={{ margin: '0 0 6px', paddingLeft: '18px', fontSize: '0.74rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                        {validation.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    {validation.suggestedFix && (
                      <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                        {validation.suggestedFix}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Options */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 28 }}>
              {current.options.map((opt, i) => {
                const isSelected  = selected === i;
                const isAnswer    = revealed && i === current.answer;
                const isWrong     = revealed && isSelected && !isAnswer;
                const isStruck    = !revealed && currentStrikeouts.has(i);

                let borderColor  = 'var(--border)';
                let bg           = 'var(--bg-raised)';
                let letterBg     = 'var(--bg-sunken)';
                let letterClr    = 'var(--text-dim)';

                if (isAnswer)       { borderColor = 'var(--green)'; bg = 'var(--green-dim)'; letterBg = 'rgba(76,122,62,0.18)'; letterClr = 'var(--green)'; }
                else if (isWrong)   { borderColor = 'var(--red)';   bg = 'var(--red-dim)';   letterBg = 'rgba(155,58,47,0.15)'; letterClr = 'var(--red)'; }
                else if (isSelected && !revealed) { borderColor = 'var(--accent)'; }

                return (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                    <button
                      onClick={() => selectOption(i)}
                      onContextMenu={e => toggleStrikeout(i, e)}
                      disabled={revealed}
                      title={!revealed ? 'Right-click or two-finger click to eliminate' : undefined}
                      style={{
                        flex: 1, display: 'flex', gap: 14, alignItems: 'flex-start',
                        padding: '14px 18px', background: bg, border: `1px solid ${borderColor}`,
                        borderRadius: 'var(--r2)', cursor: revealed ? 'default' : 'pointer',
                        textAlign: 'left', color: 'var(--text-primary)',
                        opacity: isStruck ? 0.4 : 1, transition: 'all 0.15s',
                        fontFamily: 'var(--font-sans)',
                      }}
                      onMouseEnter={e => { if (!revealed) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-primary)'; } }}
                      onMouseLeave={e => { if (!revealed) { (e.currentTarget as HTMLButtonElement).style.borderColor = borderColor; } }}
                    >
                      <span style={{
                        width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                        color: letterClr, background: letterBg,
                        textDecoration: isStruck ? 'line-through' : 'none',
                      }}>
                        {String.fromCharCode(65 + i)}
                      </span>
                      <span style={{
                        fontSize: 15, lineHeight: 1.5, flex: 1,
                        textDecoration: isStruck ? 'line-through' : 'none',
                        color: isStruck ? 'var(--text-dim)' : 'var(--text-primary)',
                      }}>
                        {opt}
                      </span>
                      {isAnswer && <Icon name="check" size={16} color="var(--green)" />}
                      {isWrong  && <Icon name="x"     size={16} color="var(--red)" />}
                    </button>
                    {!revealed && (
                      <button
                        onClick={() => toggleStrikeout(i, { preventDefault: () => {} } as React.MouseEvent)}
                        title="Eliminate"
                        style={{
                          width: 32, background: 'transparent',
                          border: `1px dashed var(--border)`,
                          borderRadius: 'var(--r2)', cursor: 'pointer',
                          color: isStruck ? 'var(--red)' : 'var(--text-disabled)',
                          fontFamily: 'var(--font-mono)', fontSize: 12,
                        }}
                      >✕</button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pre-answer hint */}
            {!revealed && (
              <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--text-dim)' }}>
                <span><Kbd>A</Kbd>–<Kbd>{String.fromCharCode(64 + current.options.length)}</Kbd> answer</span>
                <span>· ✕ eliminate</span>
                <span>· drag to highlight</span>
              </div>
            )}

            {/* Correct/incorrect badge (left column, below options) */}
            {revealed && (
              <div style={{ marginTop: 20 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  padding: '4px 10px', borderRadius: 99,
                  color: isCorrect ? 'var(--green)' : 'var(--red)',
                  background: isCorrect ? 'var(--green-dim)' : 'var(--red-dim)',
                }}>
                  <Icon name={isCorrect ? 'check' : 'x'} size={12} color={isCorrect ? 'var(--green)' : 'var(--red)'} />
                  {isCorrect ? 'Correct' : 'Incorrect'}
                </div>
              </div>
            )}

            {/* Flag issue UI */}
            {revealed && (
              <div style={{ marginTop: 12, position: 'relative', display: 'inline-block' }}>
                <button
                  onClick={() => setFlagDropOpen(o => !o)}
                  style={{
                    fontSize: '0.7rem', padding: '3px 10px', borderRadius: 99,
                    border: '1px solid var(--border)', background: 'none',
                    color: flagByIdx.get(idx) ? 'var(--amber)' : 'var(--text-dim)',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                >
                  {flagByIdx.get(idx)
                    ? `⚑ ${(flagByIdx.get(idx) as string).replace(/_/g, ' ')}`
                    : '⚑ Flag issue'}
                </button>
                {flagDropOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 9 }}
                      onClick={() => setFlagDropOpen(false)}
                    />
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 10,
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      borderRadius: 'var(--r2)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                      minWidth: 200, padding: '4px 0',
                    }}>
                      {(['wrong_answer_key', 'confusing_wording', 'out_of_scope', 'other'] as AttemptFlagReason[]).map(reason => (
                        <button
                          key={reason}
                          onClick={() => {
                            setFlagByIdx(prev => {
                              const m = new Map(prev);
                              m.set(idx, reason);
                              return m;
                            });
                            setFlagDropOpen(false);
                          }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '7px 14px',
                            background: flagByIdx.get(idx) === reason ? 'var(--amber-dim)' : 'none',
                            border: 'none', cursor: 'pointer', fontSize: '0.76rem',
                            color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-sunken)'; }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background =
                              flagByIdx.get(idx) === reason ? 'var(--amber-dim)' : 'none';
                          }}
                        >
                          {reason.replace(/_/g, ' ')}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>{/* end left column */}

          {/* ── Right column: explanation + evidence ── */}
          <div style={{
            flex: '1 1 0', minWidth: 0,
            paddingTop: 38,
            opacity: revealed ? 1 : 0,
            pointerEvents: revealed ? 'auto' : 'none',
            transition: 'opacity 0.2s ease',
          }}>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--text-primary)', margin: '0 0 16px' }}>
              {formatExplanation(current.explanation)}
            </p>

            {current.source_quote && current.source_quote !== 'UNGROUNDED' && (
              <div style={{
                padding: '14px 18px',
                background: 'var(--bg-raised)',
                borderLeft: '3px solid var(--accent)',
                borderRadius: '0 6px 6px 0',
              }}>
                <p style={{
                  fontFamily: 'var(--font-serif)', fontStyle: 'italic',
                  fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0,
                }}>
                  &ldquo;{current.source_quote}&rdquo;
                </p>
                {current.concept_name && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 8, letterSpacing: '0.06em' }}>
                    — {current.concept_name.toUpperCase()}
                  </div>
                )}
              </div>
            )}

            {/* Helpful rating */}
            {revealed && (
              <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.76rem', color: 'var(--text-dim)' }}>
                <span>Helpful?</span>
                {([true, false] as boolean[]).map(val => (
                  <button
                    key={String(val)}
                    onClick={() => setHelpfulByIdx(prev => {
                      const m = new Map(prev);
                      if (m.get(idx) === val) { m.delete(idx); } else { m.set(idx, val); }
                      return m;
                    })}
                    style={{
                      fontSize: '1rem', padding: '2px 6px',
                      border: `1px solid ${helpfulByIdx.get(idx) === val ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 'var(--r2)',
                      background: helpfulByIdx.get(idx) === val ? 'var(--accent-dim)' : 'none',
                      cursor: 'pointer', lineHeight: 1, transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    {val ? '👍' : '👎'}
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>{/* end two-column row */}
      </div>{/* end scroll body */}

      {/* Bottom rail */}
      <div style={{
        borderTop: '1px solid var(--border)', padding: '14px 24px',
        background: 'var(--bg-raised)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexShrink: 0,
        position: 'relative',
      }}>
        {!revealed ? (
          <>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', position: 'absolute', left: 24 }}>Select an answer to reveal</span>
            <button
              onClick={() => {
                if (current) {
                  fireAttempt({
                    questionId: current.id,
                    pdfId,
                    selectedOption: -1,
                    isCorrect: false,
                    timeSpentMs: Date.now() - questionStartTime,
                  });
                }
                goForward();
              }}
              style={{
                padding: '8px 14px', background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 'var(--r2)',
                color: 'var(--text-secondary)', fontSize: 13, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
                position: 'absolute', right: 24,
              }}
            >
              Skip →
            </button>
          </>
        ) : !rated[idx] ? (
          <>
            {qualityError && (
              <span style={{ fontSize: 11, color: 'var(--red)', position: 'absolute', left: 24 }}>{qualityError}</span>
            )}
            {[1, 2, 3, 4].map(quality => (
              <QualityBtn
                key={quality}
                quality={quality}
                disabled={submittingQuality !== null}
                active={submittingQuality === quality}
                onClick={() => void submitQuality(quality)}
              />
            ))}
          </>
        ) : (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--green)', position: 'absolute', left: 24 }}>
              <Icon name="check" size={12} color="var(--green)" /> Scheduled
            </span>
            <button
              onClick={goForward}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', background: 'var(--accent)', border: 'none',
                borderRadius: 'var(--r2)', cursor: 'pointer',
                color: 'var(--accent-ink)', fontSize: 13, fontWeight: 500,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {idx + 1 < questions.length ? 'Next' : 'See Results'}
              <Icon name="arrow_r" size={14} color="var(--accent-ink)" />
              <Kbd dim>↵</Kbd>
            </button>
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
