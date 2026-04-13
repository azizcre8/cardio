/**
 * SRS (SM-2 Modified) — ported verbatim from medical-study-app-v2.html.
 *
 * Only structural change from the original:
 * - `examDate` is an explicit parameter instead of reading from global STATE.
 * - `buildQueue` accepts pre-computed mastery data + concepts instead of reading
 *   from localStorage, since the server has no localStorage.
 *
 * DO NOT modify the SM-2 formula or the queue-building logic.
 */

import type { Question, Concept, MasteryData, StudyQueueItem } from '@/types';

// ─── Fisher-Yates shuffle (verbatim from HTML) ────────────────────────────────

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ─── Concept mastery computation (verbatim from HTML) ─────────────────────────

export function conceptMastery(concept: Concept, questions: Question[]): MasteryData {
  const byL: Record<1 | 2 | 3, Question[]> = { 1: [], 2: [], 3: [] };
  questions
    .filter(q => q.concept_id === concept.id)
    .forEach(q => {
      const l = Math.min(3, Math.max(1, (q.level ?? 1))) as 1 | 2 | 3;
      byL[l].push(q);
    });

  function score(qs: Question[]): number {
    const ans = qs.filter(q => (q.times_reviewed ?? 0) > 0);
    if (!ans.length) return 0;
    const tot = ans.reduce((s, q) => s + (q.times_correct ?? 0), 0);
    const att = ans.reduce((s, q) => s + (q.times_reviewed ?? 0), 0);
    return Math.min(100, Math.round((tot / att) * 100));
  }

  const l1 = score(byL[1]);
  const l2 = score(byL[2]);
  const l3 = score(byL[3]);
  const hasAny = Object.values(byL).some(qs => qs.some(q => (q.times_reviewed ?? 0) > 0));
  let overall = 0;
  if (hasAny) {
    const ws = [0.25, 0.40, 0.35];
    const cs = [byL[1].length, byL[2].length, byL[3].length];
    const vs = [l1, l2, l3];
    let wsum = 0, wtot = 0;
    vs.forEach((v, i) => {
      if (cs[i]) { wsum += v * ws[i]; wtot += ws[i]; }
    });
    overall = wtot ? Math.round(wsum / wtot) : 0;
  }

  const status: MasteryData['status'] =
    !hasAny ? 'new' :
    overall < 40 ? 'weak' :
    overall < 70 ? 'medium' :
    overall < 90 ? 'strong' : 'mastered';

  return { conceptId: concept.id, l1, l2, l3, overall, status };
}

export function computeAllMastery(concepts: Concept[], questions: Question[]): MasteryData[] {
  return concepts.map(c => conceptMastery(c, questions));
}

// ─── targetLevel (verbatim from HTML) ─────────────────────────────────────────

function targetLevel(m: MasteryData): 1 | 2 | 3 {
  if (m.l1 < 60) return 1;
  if (m.l2 < 60) return 2;
  if (m.l3 < 60) return 3;
  return ([m.l1, m.l2, m.l3].indexOf(Math.min(m.l1, m.l2, m.l3)) + 1) as 1 | 2 | 3;
}

// ─── applySRS (SM-2 Modified, verbatim — examDate parameterised) ──────────────

export function applySRS(q: Question, quality: number, examDate: Date | null): Question {
  let interval   = q.interval    ?? 0.17;
  let easeFactor = q.ease_factor ?? 2.5;
  let repetitions = q.repetitions ?? 0;

  const daysLeft = examDate
    ? Math.ceil((examDate.getTime() - Date.now()) / 86_400_000)
    : 30;

  // Quality scale: 1=Wrong (lapse), 2=Hard, 3=Good, 4=Easy
  if (quality <= 1) {
    repetitions = 0;
    interval = 0.17; // reset, review in ~4h
  } else {
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 2;
    else interval = Math.round(interval * easeFactor);
    if (examDate) interval = Math.min(interval, Math.max(0.17, daysLeft - 1));
    repetitions++;
  }

  easeFactor = Math.max(1.3, easeFactor + 0.1 - (4 - quality) * (0.08 + (4 - quality) * 0.02));

  // Recovery boost: after a lapse, reward getting it right again
  if (quality >= 3 && (q.repetitions ?? 0) === 0 && (q.times_reviewed ?? 0) > 1) {
    easeFactor = Math.min(2.5, easeFactor + 0.15);
  }

  const nextReview = new Date();
  nextReview.setTime(nextReview.getTime() + interval * 86_400_000);

  return {
    ...q,
    interval,
    ease_factor: easeFactor,
    repetitions,
    next_review: nextReview.toISOString(),
  };
}

// ─── pickSibling (verbatim from HTML) ─────────────────────────────────────────

export function pickSibling(
  dueQ: Question,
  allQuestions: Question[],
  excludeIds: Set<string>,
): Question {
  const siblings = allQuestions.filter(
    q => q.concept_id === dueQ.concept_id && q.id !== dueQ.id && !excludeIds.has(q.id),
  );
  if (!siblings.length) return dueQ; // only question for this concept — use as-is

  // Never-reviewed (null last_reviewed) sorts first (timestamp 0), then oldest-reviewed first
  siblings.sort(
    (a, b) =>
      new Date(a.last_reviewed ?? 0).getTime() -
      new Date(b.last_reviewed ?? 0).getTime(),
  );
  return siblings[0];
}

// ─── buildQueue (verbatim from HTML — data sources parameterised) ─────────────

export function buildQueue(
  questions:   Question[],
  masteryData: MasteryData[],
  concepts:    Concept[],
  examDate:    Date | null,
  limit = 28,
): StudyQueueItem[] {
  const now = new Date();
  const impRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const queue: StudyQueueItem[] = [];
  const addedIds = new Set<string>();

  function add(q: Question, extra: Partial<StudyQueueItem> = {}) {
    if (!addedIds.has(q.id)) {
      addedIds.add(q.id);
      queue.push({ ...q, _bucket: 'new', _proxiedFromId: null, ...extra } as StudyQueueItem);
    }
  }

  // Exam urgency: shift priorities when exam is close
  const daysLeft = examDate ? Math.ceil((examDate.getTime() - now.getTime()) / 86_400_000) : 60;
  const cramMode = daysLeft <= 3;
  const srsSlots = Math.floor(limit * (cramMode ? 0.6 : 0.4));

  // 1. SRS due items — show a sibling question (different angle, same concept)
  questions
    .filter(q => (q.times_reviewed ?? 0) > 0 && new Date(q.next_review ?? 0) <= now)
    .sort((a, b) => new Date(a.next_review ?? 0).getTime() - new Date(b.next_review ?? 0).getTime())
    .slice(0, srsSlots)
    .forEach(dueQ => {
      const sibling = pickSibling(dueQ, questions, addedIds);
      if (sibling.id === dueQ.id) {
        add(dueQ, { _bucket: 'srs' });
      } else {
        add(sibling, { _bucket: 'srs', _proxiedFromId: dueQ.id });
      }
    });

  // 2. Weak/new concepts — target the level they need most
  const mm = masteryData;

  function addConceptQ(mastDatum: MasteryData, level: 1 | 2 | 3, n: number, extra: Partial<StudyQueueItem> = {}) {
    const cqs = questions.filter(
      q =>
        q.concept_id === mastDatum.conceptId &&
        q.level === level &&
        ((q.times_reviewed ?? 0) === 0 || new Date(q.next_review ?? 0) <= now),
    );
    shuffle(cqs).slice(0, n).forEach(q => add(q, extra));
  }

  const weakFilter = cramMode
    ? (m: MasteryData) =>
        (m.status === 'weak' || m.status === 'new') &&
        concepts.find(c => c.id === m.conceptId)?.importance === 'high'
    : (m: MasteryData) =>
        m.status === 'weak' || m.status === 'new' || m.status === 'medium';

  const weak = mm
    .filter(m => m.status === 'weak' || m.status === 'new')
    .sort((a, b) => {
      const ca = concepts.find(c => c.id === a.conceptId);
      const cb = concepts.find(c => c.id === b.conceptId);
      const ia = impRank[ca?.importance ?? 'low'] ?? 1;
      const ib = impRank[cb?.importance ?? 'low'] ?? 1;
      return ib !== ia ? ib - ia : a.overall - b.overall;
    });

  // Fix weak/new: start at their weakest level
  weak.filter(weakFilter).slice(0, 9).forEach(m => {
    const lv = targetLevel(m);
    addConceptQ(m, lv, 2, { _bucket: 'weak' });
  });

  // Challenge medium concepts with L2/L3
  if (!cramMode) {
    const medium = mm.filter(m => m.status === 'medium');
    medium.slice(0, 5).forEach(m => {
      addConceptQ(m, 2, 1, { _bucket: 'medium' });
      addConceptQ(m, 3, 1, { _bucket: 'medium' });
    });
  }

  // 3. Fill remainder: new questions, high-yield first (skip mastered concepts)
  if (queue.length < limit) {
    const newQs = questions
      .filter(q => (q.times_reviewed ?? 0) === 0 && !addedIds.has(q.id))
      .filter(q => {
        const m = mm.find(m => m.conceptId === q.concept_id);
        return !m || m.status !== 'mastered';
      })
      .sort((a, b) => {
        const ca = concepts.find(c => c.id === a.concept_id);
        const cb = concepts.find(c => c.id === b.concept_id);
        return (impRank[cb?.importance ?? 'low'] ?? 1) - (impRank[ca?.importance ?? 'low'] ?? 1);
      });
    newQs.slice(0, limit - queue.length).forEach(q => add(q, { _bucket: 'new' }));
  }

  // Stratified shuffle: randomise within each bucket, preserve bucket priority order
  const buckets: StudyQueueItem['_bucket'][] = ['srs', 'weak', 'medium', 'new'];
  const result: StudyQueueItem[] = [];
  buckets.forEach(b => result.push(...shuffle(queue.filter(q => q._bucket === b))));
  return result.slice(0, limit);
}
