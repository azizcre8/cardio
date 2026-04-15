import type { Question } from '@/types';
import { verifyEvidenceSpan, type EvidenceVerifyResult } from './validation';

type ValidationQuestion = Pick<
  Question,
  | 'pdf_id'
  | 'concept_id'
  | 'user_id'
  | 'level'
  | 'stem'
  | 'options'
  | 'answer'
  | 'explanation'
  | 'source_quote'
  | 'evidence_start'
  | 'evidence_end'
  | 'chunk_id'
  | 'evidence_match_type'
  | 'decision_target'
  | 'deciding_clue'
  | 'most_tempting_distractor'
  | 'why_tempting'
  | 'why_fails'
  | 'option_set_flags'
  | 'flagged'
  | 'flag_reason'
>;

export interface AuditVerdictLike {
  idx: number;
  status: 'PASS' | 'REVISE';
  criterion?: string;
  critique?: string;
}

export interface DraftValidationContext {
  conceptId: string;
  conceptName: string;
  expectedLevel: number;
  evidenceCorpus: string;
}

export interface DraftValidationResult {
  ok: boolean;
  issues: string[];
  optionFlags: string[];
  evidenceOk: boolean;
  evidenceResult: EvidenceVerifyResult;
  shouldRetry: boolean;
}

export interface DeterministicQuestionValidation {
  issues: string[];
  optionFlags: string[];
  evidenceOk: boolean;
  evidenceResult: EvidenceVerifyResult;
}

export function getExpectedOptionCount(level: number): number {
  return level === 1 ? 5 : 4;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactIssue(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function canonicalizeIssue(text: string): string {
  const normalized = normalizeText(text);

  if (normalized.includes('key distinction') && (normalized.includes('missing') || normalized.includes('lacks'))) {
    return 'missing_key_distinction';
  }

  if (
    (normalized.includes('contrast') || normalized.includes('distractor')) &&
    (normalized.includes('explanation does not') || normalized.includes('explanation lacks'))
  ) {
    return 'missing_distractor_contrast';
  }

  if (
    normalized.includes('source quote') &&
    (normalized.includes('could not be verified') || normalized.includes('does not provide specific evidence'))
  ) {
    return 'source_quote_not_verified';
  }

  if (
    normalized.includes('correct answer') &&
    (normalized.includes('not clearly supported') || normalized.includes('does not support'))
  ) {
    return 'correct_answer_not_supported';
  }

  if (normalized.includes('fabricated distractor')) {
    return 'fabricated_distractor';
  }

  return normalized;
}

export function takeUnique(items: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items.map(compactIssue)) {
    const canonical = canonicalizeIssue(item);
    if (!item || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function isNegationStem(stem: string): boolean {
  return /\b(not|except|least)\b/i.test(stem);
}

export function isLevel3Stem(stem: string): boolean {
  return /^\s*A\s+\d{1,3}-year-old\s+(male|female)\s+present/i.test(stem);
}

export function runLengthAudit(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
): AuditVerdictLike[] {
  return questions.map((q, idx) => {
    const correct = q.options[q.answer] ?? '';
    const distractors = q.options.filter((_, i) => i !== q.answer);
    const correctWords = correct.trim().split(/\s+/).length;
    const avgDistractorWords =
      distractors.reduce((s, d) => s + d.trim().split(/\s+/).length, 0) / Math.max(1, distractors.length);
    const ratio = avgDistractorWords > 0 ? correctWords / avgDistractorWords : 1;

    if (ratio > 1.25) {
      return {
        idx,
        status: 'REVISE',
        criterion: 'TELL-SIGNS',
        critique: `Correct answer (${correctWords} words) is ${ratio.toFixed(1)}x longer than average distractor (${avgDistractorWords.toFixed(1)} words). Trim the correct answer or expand distractors so all options are within 2 words of each other in length.`,
      };
    }
    return { idx, status: 'PASS' };
  });
}

export function runOptionSetAudit(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
): string[][] {
  return questions.map(q => {
    const flags: string[] = [];
    const opts = q.options ?? [];
    const correct = opts[q.answer] ?? '';

    if (opts.some(o => /all of the above|none of the above/i.test(o))) {
      flags.push('NONE_ALL_OF_ABOVE');
    }

    const hasAction = opts.filter(o => /\b(administer|give|start|stop|order|perform|refer|consult|monitor|treat)\b/i.test(o)).length;
    const hasDiagnosis = opts.filter(o => /\b(syndrome|disease|disorder|itis|osis|emia|uria|pathy)\b/i.test(o)).length;
    if (hasAction >= 2 && hasDiagnosis >= 2) {
      flags.push('MIXED_CATEGORY');
    }

    const lens = opts.map(o => o.trim().split(/\s+/).length);
    const maxLen = Math.max(...lens);
    const minLen = Math.min(...lens);
    if (maxLen > minLen * 2.5 && opts.length >= 3) {
      flags.push('LENGTH_OUTLIER');
    }

    const parenCount = opts.filter(o => /\([^)]+\)/.test(o)).length;
    if (parenCount === 1 && /\([^)]+\)/.test(correct)) {
      flags.push('UNIQUE_QUALIFIER');
    }

    for (let i = 0; i < opts.length; i++) {
      for (let j = i + 1; j < opts.length; j++) {
        const wordsI = new Set(opts[i]!.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsJ = new Set(opts[j]!.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const shared = Array.from(wordsI).filter(w => wordsJ.has(w)).length;
        if (shared > 0 && shared / Math.max(1, Math.min(wordsI.size, wordsJ.size)) > 0.65) {
          flags.push(`OPTION_OVERLAP_${i}_${j}`);
        }
      }
    }

    const correctLen = correct.trim().split(/\s+/).length;
    const distractorLens = opts.filter((_, i) => i !== q.answer).map(o => o.trim().split(/\s+/).length);
    const avgDist = distractorLens.reduce((s, l) => s + l, 0) / Math.max(1, distractorLens.length);
    if (correctLen > avgDist * 1.3 && correctLen - avgDist > 4) {
      flags.push('CORRECT_LONGER_TELL');
    }

    return flags;
  });
}

function toAuditableQuestion(raw: {
  stem: string;
  options: string[];
  answer: number;
  level: number;
  explanation?: string | null;
  sourceQuote?: string | null;
  evidenceStart?: number | null;
  evidenceEnd?: number | null;
  decisionTarget?: string | null;
  decidingClue?: string | null;
  mostTemptingDistractor?: string | null;
  whyTempting?: string | null;
  whyFails?: string | null;
}): Omit<Question, 'id' | 'created_at'> {
  return {
    pdf_id: '',
    concept_id: '',
    user_id: '',
    level: raw.level as Question['level'],
    stem: raw.stem,
    options: raw.options,
    answer: raw.answer,
    explanation: raw.explanation ?? '',
    option_explanations: null,
    source_quote: raw.sourceQuote ?? '',
    evidence_start: raw.evidenceStart ?? 0,
    evidence_end: raw.evidenceEnd ?? 0,
    chunk_id: null,
    evidence_match_type: null,
    decision_target: raw.decisionTarget ?? null,
    deciding_clue: raw.decidingClue ?? null,
    most_tempting_distractor: raw.mostTemptingDistractor ?? null,
    why_tempting: raw.whyTempting ?? null,
    why_fails: raw.whyFails ?? null,
    option_set_flags: null,
    flagged: false,
    flag_reason: null,
  };
}

export function buildDeterministicQuestionValidation(
  question: ValidationQuestion,
  conceptName: string | null,
  evidenceCorpus: string,
): DeterministicQuestionValidation {
  const issues: string[] = [];
  const [lengthAudit] = runLengthAudit([question as Omit<Question, 'id' | 'created_at'>]);
  const [optionFlags] = runOptionSetAudit([question as Omit<Question, 'id' | 'created_at'>]);

  if (lengthAudit?.status === 'REVISE' && lengthAudit.critique) {
    issues.push(lengthAudit.critique);
  }

  for (const flag of optionFlags ?? []) {
    switch (flag) {
      case 'NONE_ALL_OF_ABOVE':
        issues.push('Option set uses "all of the above" or "none of the above," which violates the answer-choice rules.');
        break;
      case 'MIXED_CATEGORY':
        issues.push('Answer choices mix conceptual categories instead of staying in one comparison class.');
        break;
      case 'LENGTH_OUTLIER':
      case 'CORRECT_LONGER_TELL':
        issues.push('Option lengths create a test-taking tell rather than requiring medical knowledge.');
        break;
      case 'UNIQUE_QUALIFIER':
        issues.push('The keyed answer stands out with a unique qualifier or parenthetical detail.');
        break;
      default:
        if (flag.startsWith('OPTION_OVERLAP_')) {
          issues.push('Two answer choices are overly overlapping, which weakens distractor diversity.');
        }
        break;
    }
  }

  const expectedOptionCount = getExpectedOptionCount(question.level);
  if (question.options.length !== expectedOptionCount) {
    issues.push(`Level ${question.level} questions must have exactly ${expectedOptionCount} answer choices.`);
  }

  if (question.level === 1 && isNegationStem(question.stem)) {
    issues.push('Level 1 questions should avoid negation stems such as NOT/EXCEPT/LEAST.');
  }

  if (question.level === 3 && !isLevel3Stem(question.stem)) {
    issues.push('Level 3 questions must open with an age, sex, and presentation vignette.');
  }

  if (!question.decision_target) {
    issues.push('Question is missing the required decision target metadata.');
  }
  if (!question.deciding_clue) {
    issues.push('Question is missing the required deciding clue metadata.');
  }
  if (!question.most_tempting_distractor) {
    issues.push('Question is missing the required most tempting distractor metadata.');
  } else if (!question.options.some((opt, idx) => idx !== question.answer && opt === question.most_tempting_distractor)) {
    issues.push('Most tempting distractor must match one of the incorrect answer choices exactly.');
  }
  if (!question.why_tempting) {
    issues.push('Question is missing the required whyTempting rationale.');
  }
  if (!question.why_fails) {
    issues.push('Question is missing the required whyFails rationale.');
  }

  if (!/key distinction:/i.test(question.explanation)) {
    issues.push('Explanation is missing the required "Key distinction" teaching sentence.');
  }

  if (!/\b(whereas|however|unlike|in contrast|but fails|not because)\b/i.test(question.explanation)) {
    issues.push('Explanation does not clearly contrast the correct answer against distractors.');
  }

  let evidenceResult: EvidenceVerifyResult = { ok: false, evidenceMatchType: 'none', reason: 'not_checked' };
  let evidenceOk = false;
  const sourceQuote = String(question.source_quote ?? '').trim();
  if (!sourceQuote || sourceQuote === 'UNGROUNDED') {
    issues.push('Question is missing a grounded source quote from the PDF.');
  } else if (!evidenceCorpus.trim()) {
    issues.push('Could not load source PDF text needed to verify the evidence for this question.');
  } else {
    evidenceResult = verifyEvidenceSpan(
      sourceQuote,
      question.evidence_start ?? 0,
      question.evidence_end ?? 0,
      evidenceCorpus,
    );
    evidenceOk = evidenceResult.ok;
    if (!evidenceOk) {
      issues.push('Stored source quote could not be verified against the source PDF text.');
    }
  }

  if (question.deciding_clue && sourceQuote && sourceQuote !== 'UNGROUNDED') {
    const clue = normalizeText(question.deciding_clue);
    const quote = normalizeText(sourceQuote);
    if (clue && !quote.includes(clue) && clue.split(' ').filter(Boolean).length >= 3) {
      issues.push('Deciding clue is not clearly supported by the quoted PDF evidence.');
    }
  }

  if (conceptName && !question.stem.toLowerCase().includes(conceptName.toLowerCase()) && question.level === 1) {
    issues.push('Level 1 stem may be under-specified relative to the intended concept and source material.');
  }

  return {
    issues: takeUnique(issues),
    optionFlags: optionFlags ?? [],
    evidenceOk,
    evidenceResult,
  };
}

export function validateQuestionDraft(
  raw: Record<string, unknown>,
  ctx: DraftValidationContext,
): DraftValidationResult {
  const stem = typeof raw.question === 'string' ? raw.question : '';
  const options = Array.isArray(raw.options)
    ? raw.options.filter((opt): opt is string => typeof opt === 'string')
    : [];
  const answer = typeof raw.correctAnswer === 'number' ? raw.correctAnswer : -1;
  const conceptId = typeof raw.conceptId === 'string' ? raw.conceptId : '';
  const conceptName = typeof raw.conceptName === 'string' ? raw.conceptName : '';
  const level = Number(raw.level ?? ctx.expectedLevel) || ctx.expectedLevel;
  const expectedOptionCount = getExpectedOptionCount(ctx.expectedLevel);

  const issues: string[] = [];
  let shouldRetry = false;

  if (!stem || !options.length || answer < 0) {
    issues.push('Draft is missing the stem, options, or correctAnswer fields.');
    shouldRetry = true;
  }

  if (options.length !== expectedOptionCount) {
    issues.push(`Level ${ctx.expectedLevel} questions must have exactly ${expectedOptionCount} answer choices.`);
    shouldRetry = true;
  }

  if (answer >= options.length) {
    issues.push('correctAnswer must point to an existing option.');
    shouldRetry = true;
  }

  if (!conceptId) {
    issues.push('Draft is missing conceptId for the requested generation slot.');
    shouldRetry = true;
  } else if (conceptId !== ctx.conceptId) {
    issues.push('Draft conceptId does not match the requested generation slot.');
    shouldRetry = true;
  }

  if (conceptName && normalizeText(conceptName) !== normalizeText(ctx.conceptName)) {
    issues.push('Draft conceptName does not match the requested generation slot.');
  }

  if (level !== ctx.expectedLevel) {
    issues.push(`Draft level ${level} does not match expected level ${ctx.expectedLevel}.`);
  }

  if (!shouldRetry && stem && options.length === expectedOptionCount && answer >= 0 && answer < options.length) {
    const validation = buildDeterministicQuestionValidation(
      toAuditableQuestion({
        stem,
        options,
        answer,
        level: ctx.expectedLevel,
        explanation: typeof raw.explanation === 'string' ? raw.explanation : '',
        sourceQuote: typeof raw.sourceQuote === 'string' ? raw.sourceQuote : '',
        evidenceStart: typeof raw.evidenceStart === 'number' ? raw.evidenceStart : 0,
        evidenceEnd: typeof raw.evidenceEnd === 'number' ? raw.evidenceEnd : 0,
        decisionTarget: typeof raw.decisionTarget === 'string' ? raw.decisionTarget : null,
        decidingClue: typeof raw.decidingClue === 'string' ? raw.decidingClue : null,
        mostTemptingDistractor: typeof raw.mostTemptingDistractor === 'string' ? raw.mostTemptingDistractor : null,
        whyTempting: typeof raw.whyTempting === 'string' ? raw.whyTempting : null,
        whyFails: typeof raw.whyFails === 'string' ? raw.whyFails : null,
      }),
      ctx.conceptName,
      ctx.evidenceCorpus,
    );

    const draftShouldRetry = validation.issues.length > 0 || !validation.evidenceOk;

    return {
      ok: validation.issues.length === 0 && validation.evidenceOk,
      issues: validation.issues,
      optionFlags: validation.optionFlags,
      evidenceOk: validation.evidenceOk,
      evidenceResult: validation.evidenceResult,
      shouldRetry: draftShouldRetry,
    };
  }

  return {
    ok: false,
    issues: takeUnique(issues),
    optionFlags: [],
    evidenceOk: false,
    evidenceResult: { ok: false, evidenceMatchType: 'none', reason: 'shape_mismatch' },
    shouldRetry,
  };
}
