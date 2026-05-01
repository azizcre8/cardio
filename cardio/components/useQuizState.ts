'use client';

import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import type { AttemptFlagReason, FactCheckResult, Question } from '@/types';
import { isBinding, loadKeybindings } from '@/lib/keybindings';

export interface AnswerState {
  selected: number | null;
  revealed: boolean;
}

export interface HighlightRange {
  start: number;
  end: number;
}

export interface ValidationResult {
  loading: boolean;
  error: string | null;
  result: FactCheckResult | null;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

type SavedQuizProgress = {
  idx: number;
  answers: AnswerState[];
  rated: Record<number, boolean>;
  questionIds?: string[];
};

function quizProgressKey(pdfId: string) {
  return `cardio:quiz-progress:${pdfId}`;
}

function loadQuizProgress(pdfId: string): SavedQuizProgress | null {
  try {
    const raw = localStorage.getItem(quizProgressKey(pdfId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedQuizProgress;
    if (!Array.isArray(parsed.answers) || typeof parsed.idx !== 'number') return null;
    if (parsed.rated == null || typeof parsed.rated !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function getSavedQuestionOrder(questions: Question[], progress: SavedQuizProgress): Question[] | null {
  if (!Array.isArray(progress.questionIds) || progress.questionIds.length !== questions.length) return null;

  const questionIds = new Set(progress.questionIds);
  if (questionIds.size !== questions.length) return null;

  const byId = new Map(questions.map(q => [q.id, q]));
  const ordered = progress.questionIds.map(id => byId.get(id));
  if (ordered.some(q => q == null)) return null;

  return ordered as Question[];
}

function canResumeSavedProgress(questions: Question[], progress: SavedQuizProgress): boolean {
  return questions.length > 0
    && progress.answers.length === questions.length
    && Number.isInteger(progress.idx)
    && progress.idx >= 0
    && progress.idx < questions.length;
}

function saveQuizProgress(pdfId: string, progress: SavedQuizProgress) {
  try {
    localStorage.setItem(quizProgressKey(pdfId), JSON.stringify(progress));
  } catch { /* ignore storage quota */ }
}

function clearQuizProgress(pdfId: string) {
  try {
    localStorage.removeItem(quizProgressKey(pdfId));
  } catch { /* ignore */ }
}

export function useQuizQuestions({
  pdfId,
  sharedBankSlug,
  deckId,
}: {
  pdfId?: string;
  sharedBankSlug?: string;
  deckId?: string;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<AnswerState[]>([]);
  const [loading, setLoading] = useState(true);
  const [rated, setRated] = useState<Record<number, boolean>>({});
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [streak, setStreak] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  const sourceKey = sharedBankSlug
    ? `shared-bank:${sharedBankSlug}`
    : deckId
    ? `deck:${deckId}`
    : (pdfId ?? '');

  useEffect(() => {
    const questionUrl = sharedBankSlug
      ? `/api/shared-banks/${encodeURIComponent(sharedBankSlug)}/questions`
      : deckId
      ? `/api/decks/${encodeURIComponent(deckId)}/questions`
      : `/api/pdfs/${pdfId ?? ''}/questions`;

    fetch(questionUrl)
      .then(r => r.json())
      .then(d => {
        const qs: Question[] = d.questions ?? [];
        const saved = loadQuizProgress(sourceKey);
        const savedQuestionOrder = saved ? getSavedQuestionOrder(qs, saved) : null;
        const initialQuestions = savedQuestionOrder ?? qs;

        setQuestions(initialQuestions);
        if (saved && savedQuestionOrder && canResumeSavedProgress(savedQuestionOrder, saved)) {
          setIdx(saved.idx);
          setAnswers(saved.answers);
          setRated(saved.rated);
          setResumeAvailable(false);
        } else {
          setIdx(0);
          setAnswers(initialQuestions.map(() => ({ selected: null, revealed: false })));
          setRated({});
          setResumeAvailable(false);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [deckId, pdfId, sharedBankSlug, sourceKey]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  return {
    questions,
    setQuestions,
    idx,
    setIdx,
    answers,
    setAnswers,
    loading,
    rated,
    setRated,
    resumeAvailable,
    setResumeAvailable,
    streak,
    setStreak,
    elapsed,
    sourceKey,
  };
}

export function useQuizProgressPersistence({
  sourceKey,
  questions,
  answers,
  idx,
  rated,
  resumeAvailable,
}: {
  sourceKey: string;
  questions: Question[];
  answers: AnswerState[];
  idx: number;
  rated: Record<number, boolean>;
  resumeAvailable: boolean;
}) {
  useEffect(() => {
    if (!questions.length || answers.length !== questions.length || idx >= questions.length || resumeAvailable) return;
    saveQuizProgress(sourceKey, { idx, answers, rated, questionIds: questions.map(q => q.id) });
  }, [answers, idx, questions, rated, resumeAvailable, sourceKey]);

  function clearProgress() {
    clearQuizProgress(sourceKey);
  }

  return { clearProgress };
}

export function useQuizKeyboardShortcuts({
  questions,
  idx,
  revealed,
  rated,
  submittingQuality,
  onDone,
  selectAnswer,
  submitQuality,
  goForward,
  goBack,
}: {
  questions: Question[];
  idx: number;
  revealed: boolean;
  rated: Record<number, boolean>;
  submittingQuality: number | null;
  onDone: () => void;
  selectAnswer: (optIdx: number) => void;
  submitQuality: (quality: number) => Promise<void>;
  goForward: () => void;
  goBack: () => void;
}) {
  const [focusMode, setFocusMode] = useState(false);
  const [keybindings, setKeybindings] = useState(loadKeybindings);

  useEffect(() => {
    function refresh() { setKeybindings(loadKeybindings()); }
    window.addEventListener('storage', refresh);
    window.addEventListener('cardio:keybindings-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('cardio:keybindings-changed', refresh);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const current = questions[idx];
      if (!current) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Escape') { if (focusMode) setFocusMode(false); else onDone(); return; }
      if (e.key === 'f' || e.key === 'F') { setFocusMode(m => !m); return; }
      const n = parseInt(e.key);
      if (!revealed && n >= 1 && n <= current.options.length) {
        selectAnswer(n - 1);
      } else if (revealed && n >= 1 && n <= 4 && !rated[idx] && !submittingQuality) {
        void submitQuality(n);
      } else if (revealed && rated[idx] && (n >= 1 && n <= 4)) {
        if (idx < questions.length) goForward();
      } else if (isBinding(e, keybindings, 'quiz.next') || (revealed && e.key === 'Enter')) {
        if (revealed && !rated[idx]) return;
        if (idx < questions.length) goForward();
      } else if (isBinding(e, keybindings, 'quiz.previous')) {
        goBack();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return { focusMode, setFocusMode };
}

export function useQuestionActions({
  questions,
  setQuestions,
  idx,
  setIdx,
  answers,
  setAnswers,
  revealed,
  setStreak,
  setResumeAvailable,
  setRated,
  clearProgress,
  clearQualityError,
  resetHighlightAndStrikeouts,
  resetQualityForRestart,
  resetQualityForReviewMissed,
}: {
  questions: Question[];
  setQuestions: StateSetter<Question[]>;
  idx: number;
  setIdx: StateSetter<number>;
  answers: AnswerState[];
  setAnswers: StateSetter<AnswerState[]>;
  revealed: boolean;
  setStreak: StateSetter<number>;
  setResumeAvailable: StateSetter<boolean>;
  setRated: StateSetter<Record<number, boolean>>;
  clearProgress: () => void;
  clearQualityError: () => void;
  resetHighlightAndStrikeouts: () => void;
  resetQualityForRestart: () => void;
  resetQualityForReviewMissed: () => void;
}) {
  function selectAnswer(optIdx: number) {
    if (revealed) return;
    clearQualityError();
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
    clearProgress();
    setResumeAvailable(false);
    setIdx(0);
    setAnswers(questions.map(() => ({ selected: null, revealed: false })));
    setRated({});
    resetHighlightAndStrikeouts();
    resetQualityForRestart();
  }

  function reviewMissed() {
    clearProgress();
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
    resetHighlightAndStrikeouts();
    resetQualityForReviewMissed();
  }

  return {
    selectAnswer,
    goBack,
    goForward,
    restart,
    reviewMissed,
  };
}

export function useQualitySubmission({
  idx,
  current,
  pdfId,
  selected,
  rated,
  setRated,
  setIdx,
}: {
  idx: number;
  current: Question | undefined;
  pdfId?: string;
  selected: number | null;
  rated: Record<number, boolean>;
  setRated: StateSetter<Record<number, boolean>>;
  setIdx: StateSetter<number>;
}) {
  const [submittingQuality, setSubmittingQuality] = useState<number | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [validationByIdx, setValidationByIdx] = useState<Map<number, ValidationResult>>(new Map());
  const [questionStartTime, setQuestionStartTime] = useState<number>(Date.now());
  const [flagByIdx, setFlagByIdx] = useState<Map<number, AttemptFlagReason>>(new Map());
  const [helpfulByIdx, setHelpfulByIdx] = useState<Map<number, boolean>>(new Map());
  const [flagDropOpen, setFlagDropOpen] = useState(false);
  const currentPdfId = current?.pdf_id ?? pdfId ?? '';

  useEffect(() => {
    setQuestionStartTime(Date.now());
    setFlagDropOpen(false);
  }, [idx]);

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

  async function submitQuality(quality: number) {
    if (!current || rated[idx] || submittingQuality !== null) return;

    setSubmittingQuality(quality);
    setQualityError(null);

    try {
      const timeSpentMs = Date.now() - questionStartTime;
      fireAttempt({
        questionId: current.id,
        pdfId: currentPdfId,
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
          pdfId: currentPdfId,
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
      setIdx(i => i + 1);
    } catch (err) {
      setQualityError(err instanceof Error ? err.message : 'Failed to save SRS review.');
    } finally {
      setSubmittingQuality(null);
    }
  }

  async function validateCurrentQuestion() {
    if (!current) return;

    setValidationByIdx(prev => {
      const next = new Map(prev);
      next.set(idx, {
        loading: true,
        error: null,
        result: null,
      });
      return next;
    });

    try {
      const res = await fetch(`/api/questions/${current.id}/factcheck`);

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'Validation failed.');

      setValidationByIdx(prev => {
        const next = new Map(prev);
        next.set(idx, {
          loading: false,
          error: null,
          result: {
            medicallyAccurate: Boolean(data?.medicallyAccurate),
            sourcedFromText: Boolean(data?.sourcedFromText),
          },
        });
        return next;
      });
    } catch (err) {
      setValidationByIdx(prev => {
        const next = new Map(prev);
        next.set(idx, {
          loading: false,
          error: err instanceof Error ? err.message : 'Validation failed.',
          result: null,
        });
        return next;
      });
    }
  }

  function clearQualityError() {
    setQualityError(null);
  }

  function resetBaseQualityState() {
    setSubmittingQuality(null);
    setQualityError(null);
    setFlagByIdx(new Map());
    setHelpfulByIdx(new Map());
    setFlagDropOpen(false);
    setQuestionStartTime(Date.now());
  }

  function resetQualityForRestart() {
    resetBaseQualityState();
    setValidationByIdx(new Map());
  }

  function resetQualityForReviewMissed() {
    resetBaseQualityState();
  }

  return {
    submittingQuality,
    qualityError,
    validationByIdx,
    questionStartTime,
    flagByIdx,
    helpfulByIdx,
    flagDropOpen,
    setFlagDropOpen,
    setFlagByIdx,
    setHelpfulByIdx,
    currentPdfId,
    submitQuality,
    fireAttempt,
    validateCurrentQuestion,
    clearQualityError,
    resetQualityForRestart,
    resetQualityForReviewMissed,
  };
}

export function useHighlightAndStrikeoutHandlers({
  idx,
  revealed,
}: {
  idx: number;
  revealed: boolean;
}) {
  const [highlights, setHighlights] = useState<Map<number, HighlightRange[]>>(new Map());
  const [strikeouts, setStrikeouts] = useState<Map<number, Set<number>>>(new Map());
  const stemRef = useRef<HTMLParagraphElement>(null);

  const currentHighlights = highlights.get(idx) ?? [];
  const currentStrikeouts = strikeouts.get(idx) ?? new Set<number>();

  function handleStemMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !stemRef.current) return;

    const range = sel.getRangeAt(0);
    const selectedText = range.toString();
    if (!selectedText.length) return;
    if (!stemRef.current.contains(range.commonAncestorContainer)) return;

    const preRange = range.cloneRange();
    preRange.selectNodeContents(stemRef.current);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + selectedText.length;

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

  function toggleStrikeout(optIdx: number, e: ReactMouseEvent) {
    e.preventDefault();
    if (revealed) return;
    setStrikeouts(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(idx) ?? []);
      if (set.has(optIdx)) {
        set.delete(optIdx);
      } else {
        set.add(optIdx);
      }
      next.set(idx, set);
      return next;
    });
  }

  function resetHighlightAndStrikeouts() {
    setHighlights(new Map());
    setStrikeouts(new Map());
  }

  return {
    stemRef,
    currentHighlights,
    currentStrikeouts,
    handleStemMouseUp,
    clearHighlights,
    toggleStrikeout,
    resetHighlightAndStrikeouts,
  };
}
