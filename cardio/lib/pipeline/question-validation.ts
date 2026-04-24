import type { Question } from '@/types';
import { hasEvidenceAnchorSupport, verifyEvidenceSpan, type EvidenceVerifyResult } from './validation';
import {
  detectExplanationAnswerMismatch,
  normalizeText,
  stripOptionLabel,
} from './answer-key-check';

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

export function validateSourceQuoteShape(sourceQuote: string): string | null {
  const trimmed = sourceQuote.trim();
  if (!trimmed) return null;

  // Guard against truncated fragments — a real sentence starts with a capital
  // letter (or a recognised abbreviation). Chunks sometimes start mid-sentence
  // due to PDF extraction (e.g. "- ing of the bladder are periodic acute…").
  if (/^[-–—]/.test(trimmed) || /^[a-z]/.test(trimmed)) {
    return 'Source quote appears to be a mid-sentence fragment — pick a complete sentence that starts with a capital letter.';
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 10) {
    return 'Source quote must be at least 10 words copied verbatim from the source passages.';
  }
  // Hard cap: quotes longer than ~35 words are almost always a paragraph or
  // multi-clause stitch, even when sentence-terminator regex misses it
  // (em-dashes, semicolons, abbreviations like "i.e.", "Dr.", etc.).
  // Audit on pathology-ch11a flagged 35+ items as "long source quote" — this
  // gate is the deterministic fix.
  if (wordCount > 35) {
    return `Source quote is too long (${wordCount} words). Pick a single body-text sentence under 35 words that directly proves the keyed answer.`;
  }

  // Guard against multi-sentence stitching or a clause ripped out of the middle of a sentence.
  const sentenceTerminators = trimmed.match(/[.!?](?=\s|$)/g) ?? [];
  if (sentenceTerminators.length > 1) {
    return 'Source quote must be a single sentence from the source passages — do not merge multiple sentences.';
  }
  if (sentenceTerminators.length === 0 && wordCount < 18) {
    return 'Source quote must be a complete sentence ending in a period from the source passages.';
  }

  // Guard against table-of-contents or index pages (high density of page numbers).
  const pageNumberMatches = (trimmed.match(/\b\d{3,4}\b/g) ?? []).length;
  if (pageNumberMatches >= 3 && pageNumberMatches / wordCount > 0.07) {
    return 'Source quote appears to be a table of contents or index page — use a verbatim sentence from the body text.';
  }

  // Guard against embedded MCQ text (e.g. "A Endothelial cell disruption B Intimal
  // thickening C Lymphocytic infiltrates..."). Textbooks that include practice questions
  // can leak Q&A option-list text into the evidence corpus; it is never a valid quote.
  const mcqOptionPattern = /\b[A-E]\s+[A-Z][a-z].{3,}\s+[B-E]\s+[A-Z]/;
  if (mcqOptionPattern.test(trimmed)) {
    return 'Source quote appears to be a multiple-choice option list, not prose. Pick a single explanatory sentence from the body text.';
  }

  // Guard against question stems being used as quotes.
  if (/\bWhich of the following\b.*\?$/.test(trimmed) || /\bWhat is the most likely\b.*\?$/.test(trimmed)) {
    return 'Source quote must be explanatory prose from the source, not a test question stem.';
  }

  return null;
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

  if (
    normalized.includes('explanation') &&
    (normalized.includes('different answer choice') || normalized.includes('keyed correct answer'))
  ) {
    return 'explanation_answer_mismatch';
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

export function stemIsInterrogative(stem: string): boolean {
  const trimmed = stem.trim();
  if (!trimmed) return false;

  const citationStripped = trimmed.replace(/(?:\s*\([^)]*\)\s*)+$/, '').trim();
  if (/\?\s*$/.test(citationStripped)) return true;

  const sentences = citationStripped.split(/(?<=[.!?])\s+/);
  const lastSentence = (sentences[sentences.length - 1] ?? citationStripped).trim();
  return /^(which|what|how|why|when|where|identify|select the|choose the)\b/i.test(lastSentence);
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
    const absoluteDiff = correctWords - avgDistractorWords;

    // Small noun-phrase answer sets often differ by only 1-2 words, which is not a
    // meaningful tell. Reserve this audit for clearly dominant keyed answers.
    if (ratio >= 1.6 && absoluteDiff >= 2.5 && correctWords >= 5) {
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

    // Detect artificial shared suffix (all options end with the same word).
    if (opts.length >= 3) {
      const lastWords = opts.map(o => o.trim().split(/\s+/).pop()?.toLowerCase() ?? '');
      if (lastWords[0] && lastWords[0].length >= 4 && lastWords.every(w => w === lastWords[0])) {
        flags.push('SHARED_SUFFIX');
      }
    }

    // Detect artificial descriptor suffixes padded onto option text (e.g.
    // "Sodium Ion Concentration Level", "Creatinine Measurement", "GFR Value").
    // These are almost always writer padding — the discriminating concept name is
    // enough. Flag when ≥60% of options carry one of these trailing descriptor words.
    const DESCRIPTOR_SUFFIX_WORDS = new Set([
      'level', 'levels', 'rate', 'rates', 'measurement', 'measurements',
      'evaluation', 'testing', 'analysis', 'profiling', 'assessment',
      'concentration', 'value', 'reading', 'index', 'ratio',
    ]);
    if (opts.length >= 3) {
      const suffixedCount = opts.filter(o => {
        const words = o.trim().toLowerCase().split(/\s+/);
        return words.length >= 3 && DESCRIPTOR_SUFFIX_WORDS.has(words[words.length - 1] ?? '');
      }).length;
      if (suffixedCount >= Math.ceil(opts.length * 0.6)) {
        flags.push('DESCRIPTOR_SUFFIX');
      }
    }

    // Detect mixing of anatomical structures and physiological processes/mechanisms.
    // These comparisons are "fundamentally broken" — a student cannot reason across them.
    const isAnatomyTerm = (o: string) =>
      /\b(muscle|nerve|duct|tubule|glomerulus|vessel|artery|vein|capillary|cortex|medulla|pelvis|ureter|bladder|sphincter|nephron|loop|gland|lobe|capsule|node|valve|receptor|cell)\b/i.test(o);
    const isMechanismOrProcessTerm = (o: string) =>
      /\b(filtration|reabsorption|secretion|regulation|compliance|excretion|absorption|transport|diffusion|inhibition|activation|pathway|reflex|mechanism|cystometrogram|urodynamic|electromyograph|uroflowmetr)\b/i.test(o);
    const anatomyCount = opts.filter(isAnatomyTerm).length;
    const mechanismCount = opts.filter(isMechanismOrProcessTerm).length;
    if (anatomyCount >= 2 && mechanismCount >= 2) {
      flags.push('ANATOMY_MECHANISM_MIX');
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
      case 'SHARED_SUFFIX':
        issues.push('All options end with the same word — remove the artificial suffix so each option reads naturally.');
        break;
      case 'DESCRIPTOR_SUFFIX':
        issues.push('Options contain artificial descriptor suffixes (Level/Rate/Measurement/Evaluation/Value etc.) — use bare concept names or natural phrases without tacked-on descriptor nouns.');
        break;
      case 'ANATOMY_MECHANISM_MIX':
        issues.push('Options mix anatomical structures with physiological mechanisms/processes — all options must stay in one comparison class.');
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

  // Detect definition-soup stems — template-style stems that just ask students to match a
  // definition rather than reason clinically or mechanistically.
  const DEFINITION_SOUP_PATTERNS = [
    /^the concept defined by/i,
    /^the condition defined by/i,
    /^the (renal|glomerular|tubular|interstitial|pathological?) (pathology|condition|disease|process) (best )?characterized by/i,
    /^which (renal|glomerular|tubular|pathological?) (condition|disease|process|pathology) is (best )?characterized by/i,
  ];
  if (DEFINITION_SOUP_PATTERNS.some(p => p.test(question.stem.trim()))) {
    issues.push(
      'Stem uses a definition-lookup template ("The concept defined by…" / "The condition characterized by…") — rewrite as a clinical or mechanistic question requiring the student to reason, not match a dictionary entry.',
    );
  }

  if (question.level === 3 && !isLevel3Stem(question.stem)) {
    issues.push('Level 3 questions must open with an age, sex, and presentation vignette.');
  }

  if (!stemIsInterrogative(question.stem)) {
    issues.push('Stem is not phrased as a question.');
  }

  if (!question.decision_target) {
    issues.push('Question is missing the required decision target metadata.');
  }
  if (!question.deciding_clue) {
    issues.push('Question is missing the required deciding clue metadata.');
  }
  if (!question.most_tempting_distractor) {
    issues.push('Question is missing the required most tempting distractor metadata.');
  } else {
    const normalizedMostTempting = stripOptionLabel(question.most_tempting_distractor);
    const hasMatchingDistractor = question.options.some((opt, idx) => (
      idx !== question.answer && stripOptionLabel(opt) === normalizedMostTempting
    ));
    if (!hasMatchingDistractor) {
      issues.push('Most tempting distractor must match one of the incorrect answer choices exactly.');
    }
  }
  if (!question.why_tempting) {
    issues.push('Question is missing the required whyTempting rationale.');
  }
  if (!question.why_fails) {
    issues.push('Question is missing the required whyFails rationale.');
  }

  const explanation = String(question.explanation ?? '').trim();
  if (!explanation) {
    issues.push('Question is missing an explanation.');
  } else {
    const explanationWords = explanation.split(/\s+/).length;
    if (explanationWords < 12) {
      issues.push('Explanation is too short to teach why the correct answer is right and the top distractor is wrong.');
    }
    if (/\bkey distinction\b/i.test(explanation)) {
      issues.push(
        'Explanation must not include the phrase "Key distinction" — embed the teaching point as plain prose in the two required sentences.',
      );
    }
  }

  const explanationAnswerMismatch = detectExplanationAnswerMismatch(
    question.options,
    question.answer,
    question.explanation,
  );
  if (explanationAnswerMismatch) {
    issues.push(explanationAnswerMismatch);
  }

  let evidenceResult: EvidenceVerifyResult = { ok: false, evidenceMatchType: 'none', reason: 'not_checked' };
  let evidenceOk = false;
  const sourceQuote = String(question.source_quote ?? '').trim();
  if (!sourceQuote || sourceQuote === 'UNGROUNDED') {
    issues.push('Question is missing a grounded source quote from the PDF.');
  } else if (!evidenceCorpus.trim()) {
    issues.push('Could not load source PDF text needed to verify the evidence for this question.');
  } else {
    const shapeIssue = validateSourceQuoteShape(sourceQuote);
    if (shapeIssue) issues.push(shapeIssue);

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
    const evidenceAnchor = evidenceResult.evidenceMatchedText || sourceQuote;
    const quote = normalizeText(evidenceAnchor);
    if (clue && !quote.includes(clue) && clue.split(' ').filter(Boolean).length >= 3) {
      const correctOption = question.options[question.answer] ?? '';
      const clueSupported = hasEvidenceAnchorSupport(question.deciding_clue, evidenceAnchor);
      const answerSupported = hasEvidenceAnchorSupport(correctOption, evidenceAnchor);
      if (!clueSupported && !answerSupported) {
        issues.push('Deciding clue is not clearly supported by the quoted PDF evidence.');
      }
    }
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
