/**
 * Phase 6 — Multi-agent clinical audit (Auditor + Writer revision loop).
 * Verbatim prompt templates from medical-study-app-v2.html.
 *
 * Architecture:
 *   Writer Agent (gpt-4o) ──► Auditor Agent (gpt-4o, judge)
 *        ▲                           │
 *        └──── REVISE feedback ──────┘  (max MAX_REVISE_ITERATIONS loops)
 *                                   │── PASS  → question bank
 *                                   └── REJECT (after max loops) → flagged store
 */

import { callOpenAI, inferEvidenceProvenance, parseJSON, normaliseQuestion, repairDraftForValidation, writerAgentRevise, AUDITOR_MODEL } from './generation';
import type { ChunkRecord, Question } from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';
import { buildDeterministicQuestionValidation } from './question-validation';
import { detectConceptMismatch, detectExplanationAnswerMismatch } from './answer-key-check';

const MAX_REVISE_ITERATIONS = 2;

export interface AuditVerdict {
  idx:                    number;
  status:                 'PASS' | 'REVISE' | 'REJECT';
  criterion?:             string;
  critique?:              string;
  primaryFlaw?:           string;
  weakDistractor?:        string;
  suggestedDecidingClue?: string;
  fixInstruction?:        string;
}

interface HardRejected {
  conceptId:    string;
  conceptName:  string;
  level:        number;
  criterion:    string;
  critique:     string;
  attempts:     number;
  lastQuestion: Omit<Question, 'id' | 'created_at'>;
}

interface InlineAuditFailure {
  criterion: string;
  critique: string;
}

export function deterministicVerdict(
  idx: number,
  issues: string[],
): AuditVerdict {
  if (!issues.length) return { idx, status: 'PASS' };

  const normalizedIssues = issues.map(issue => issue.toLowerCase());
  const hasIssue = (pattern: RegExp) => normalizedIssues.some(issue => pattern.test(issue));

  if (
    hasIssue(/source quote|grounded source quote|quoted pdf evidence|deciding clue is not clearly supported|correct answer is not clearly supported/)
  ) {
    return {
      idx,
      status: 'REVISE',
      criterion: 'EVIDENCE_GROUNDING',
      critique: 'Replace sourceQuote with one verbatim sentence from the source passages that directly proves the keyed answer and supports the deciding clue.',
      primaryFlaw: 'evidence grounding',
      fixInstruction: 'Copy one verbatim proving sentence from the PDF and align the deciding clue to that evidence.',
    };
  }

  if (hasIssue(/option lengths create|correct answer.*longer than average|trim the correct answer|expand distractors/)) {
    const lengthDetail = issues.find(i => /longer than average|words.*longer/i.test(i)) ?? 'correct answer is longer than distractors';
    return {
      idx,
      status: 'REVISE',
      criterion: 'OPTION_SET_HOMOGENEITY',
      critique: `Length tell: ${lengthDetail}. Do NOT shorten the correct answer — instead expand every distractor to match it in word count and grammatical structure. Use full mechanistic or descriptive phrases for all options (e.g. "Decreased X due to reduced Y" for every choice, not bare noun phrases for distractors). All options must be within 2 words of each other.`,
      primaryFlaw: 'length tell',
      fixInstruction: 'Expand all distractors to match the correct answer in length and structure — full phrases for every option, no bare noun phrases.',
    };
  }

  if (
    hasIssue(/unique qualifier|overly overlapping|mix conceptual categories|all of the above|most tempting distractor/)
  ) {
    return {
      idx,
      status: 'REVISE',
      criterion: 'OPTION_SET_HOMOGENEITY',
      critique: 'Rewrite the full option set so every choice stays in one comparison class, the distractors are distinct near-misses, and no option-length or overlap tell remains; keep mostTemptingDistractor equal to one incorrect option.',
      primaryFlaw: 'option-set weakness',
      fixInstruction: 'Rewrite the entire option set for parity, diversity, and one-to-one distractor competition.',
    };
  }

  if (
    hasIssue(/decision target metadata|deciding clue metadata|most tempting distractor metadata|whytempting|whyfails|explanation is too short/)
  ) {
    return {
      idx,
      status: 'REVISE',
      criterion: 'CLINICAL_PEDAGOGY',
      critique: 'Keep the stem and answer set, but rewrite the explanation and metadata so decisionTarget, decidingClue, whyTempting, and whyFails are present and the two-sentence explanation teaches why the keyed answer is right and the top distractor is wrong.',
      primaryFlaw: 'explanation and metadata',
      fixInstruction: 'Repair the teaching explanation and metadata without changing the tested concept.',
    };
  }

  if (hasIssue(/level 1 questions should avoid negation|level 3 questions must open|under-specified/)) {
    return {
      idx,
      status: 'REVISE',
      criterion: 'STEM_LEVEL_FIDELITY',
      critique: 'Rewrite the stem so it matches the required level and is specific enough to answer before looking at the options.',
      primaryFlaw: 'stem-level mismatch',
      fixInstruction: 'Adjust the stem to the required level while preserving the concept and keyed answer.',
    };
  }

  return {
    idx,
    status: 'REJECT',
    criterion: 'DETERMINISTIC_VALIDATION',
    critique: issues[0],
  };
}

function isLowRiskDefinitionItem(
  question: Omit<Question, 'id' | 'created_at'>,
  validation: ReturnType<typeof buildDeterministicQuestionValidation>,
): boolean {
  if (question.level !== 1 && question.level !== 2) return false;
  if (!validation.evidenceOk || validation.issues.length || validation.optionFlags.length) return false;

  const conciseOptions = question.options.every(option => option.trim().split(/\s+/).length <= 4);
  if (!conciseOptions) return false;

  return /\bdefined as\b|\bwhich concept\b|\bwhich property\b|\bwhich vascular property\b|\bwhat property\b|\bconcept of\b/i.test(question.stem);
}

function isCuratedPressureVolumePropertyItem(
  question: Omit<Question, 'id' | 'created_at'>,
  validation: ReturnType<typeof buildDeterministicQuestionValidation>,
): boolean {
  if (!validation.evidenceOk || validation.issues.length || validation.optionFlags.length) return false;
  if (!['Vascular Distensibility', 'Vascular Compliance'].includes(question.concept_name ?? '')) return false;
  return /\bvascular property\b|\bstored per mm hg pressure rise\b|\bfractional increase in volume\b|\bstore much more blood\b/i.test(question.stem);
}

// ─── runAuditAgent — upgraded prompt ─────────────────────────────────────────

export async function runAuditAgent(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
  validations: Array<{ evidenceOk: boolean; optionFlags: string[] }>,
  onCost?: OpenAICostTracker,
): Promise<AuditVerdict[]> {
  if (!questions.length) return [];

  const letters = ['A', 'B', 'C', 'D', 'E'];
  const serializeAuditField = (value: string | null | undefined, fallback: string) =>
    JSON.stringify(value && value.trim().length ? value : fallback);
  const qList = questions.map((q, i) =>
    `Q${i + 1} [${q.concept_id || '?'}] L${q.level}
Stem: ${q.stem}
Options: ${q.options.map((o, j) => `${j === q.answer ? '★' : ''}${letters[j]}) ${o}`).join(' | ')}
SourceQuote: ${serializeAuditField(q.source_quote, '(none)')}
EvidenceValid: ${validations[i]?.evidenceOk ? 'true' : 'false'}
DecisionTarget: ${serializeAuditField(q.decision_target, '(not specified)')}
DecidingClue: ${serializeAuditField(q.deciding_clue, '(not specified)')}
MostTemptingDistractor: ${serializeAuditField(q.most_tempting_distractor, '(not specified)')}
ProgrammaticFlags: ${validations[i]?.optionFlags?.length ? validations[i]!.optionFlags.join(', ') : 'none'}`,
  ).join('\n\n');

  const prompt = `You are a Senior USMLE/COMLEX Clinical Audit Agent. Judge each question strictly. Respond ONLY with valid JSON.

QUESTIONS TO AUDIT:
${qList}

EVALUATE EACH QUESTION against these criteria. Use DecisionTarget, DecidingClue, MostTemptingDistractor fields when present.

1. SINGLE TASK + DECIDING CLUE — One question tests one concept via one cognitive task. The decidingClue must be singular and explicitly knowable from the source text.
   Fail: stem tests two independent facts simultaneously. Fail: no clear deciding clue exists.

2. OPTION-SET HOMOGENEITY — All options belong to the same comparison class and each wrong option differs from the correct answer by exactly one clinically meaningful feature.
   Fail: options mix categories (drugs with symptoms, mechanisms with structures). Fail: any distractor is wrong for multiple independent reasons.
   Note: L1 questions have 5 options (A-E), L2/L3 have 4 options (A-D) — both are correct formats.

3. COMPETITIVE DISTRACTORS — At least 2 distractors are plausible near-misses. At least 1 reflects a classic misconception or confusion pair.
   Fail: fewer than 2 distractors require concept-specific knowledge to eliminate. If MostTemptingDistractor is listed, verify it is genuinely competitive; if not, flag it.
   Check ProgrammaticFlags — if NONE_ALL_OF_ABOVE or MIXED_CATEGORY is present, auto-fail this criterion.

4. TELL-SIGNS — No length tell, no qualifier tell, no keyword mirror, no specificity asymmetry.
   Fail: correct answer is noticeably longer or uses mechanistic connectors while distractors are bare noun phrases.
   Check ProgrammaticFlags — if CORRECT_LONGER_TELL or LENGTH_OUTLIER is present, auto-fail this criterion.

5. STEM QUALITY + LEVEL FIDELITY — Stem is specific enough to answer before seeing options. Level matches intended depth.
   Fail L1: uses negation stem. Fail L2: is just a definition question ("What is the role/function of X" with no additional context). Fail L3: no age/sex/presentation, or contains irrelevant vignette padding.

6. CLINICAL/PEDAGOGIC VALUE — The deciding clue teaches a reusable rule. The explanation names the mostTemptingDistractor and explains why it fails with contrast language (whereas/however/unlike/in contrast/not because).
   Fail: explanation says "the others are incorrect" without naming specific distractors. Fail: explanation lacks contrast language.
   If decidingClue is listed but not supported by the explanation or sourceQuote, flag as evidence-clue mismatch.

7. EVIDENCE GROUNDING — sourceQuote directly proves the correct answer. If EvidenceValid is false or quote looks fabricated, fail this criterion.

8. PARTIAL-INFORMATION RESISTANCE — A student who knows the organ system but not the specific concept cannot narrow to 1 option.
   Fail: any distractor is instantly eliminable without concept-specific knowledge.

9. DISTRACTOR VALIDITY — Every wrong option is a real, medically accurate entity in some context. No physiologically impossible mechanisms or fabricated phrases.

10. CONVERGENCE — No dominant shared keyword across 3+ options that the correct answer does not share. No polarity clustering (all "increased"/"decreased" while correct answer differs).

VERDICT RULES:
- PASS: meets all criteria.
- REVISE: exactly ONE fixable flaw. Critique must: (a) name the criterion, (b) identify the specific weak element (which distractor, what tell, what clue is missing), (c) give a one-sentence specific fix instruction. Also return: primaryFlaw (brief phrase), weakDistractor (option letter A-E if applicable), suggestedDecidingClue (if missing), fixInstruction (exact one-sentence instruction).
- REJECT: multiple simultaneous failures, factually incorrect correct answer, or irreparably ambiguous stem.

Return compact JSON array:
[
  {"idx":0,"status":"PASS"},
  {"idx":1,"status":"REVISE","criterion":"COMPETITIVE_DISTRACTORS","critique":"Option B can be eliminated without knowing this concept — replace with a distractor exploiting the inhibitory vs excitatory confusion","primaryFlaw":"weak distractor","weakDistractor":"B","suggestedDecidingClue":"inhibitory vs excitatory myenteric neuron distinction","fixInstruction":"Replace option B with a distractor that requires distinguishing inhibitory from excitatory myenteric neurons"},
  {"idx":2,"status":"REJECT","criterion":"HOMOGENEITY","critique":"Options mix drug mechanisms with anatomical structures — fundamentally broken option set"}
]

Be strict but fair. REVISE for one fixable flaw. REJECT only when fundamentally broken.`;

  try {
    const { text } = await callOpenAI(prompt, 1500, AUDITOR_MODEL, onCost);
    const results = parseJSON(text);
    if (!Array.isArray(results)) {
      return questions.map((_, i) => ({
        idx: i,
        status: 'REJECT' as const,
        criterion: 'AUDIT_AGENT_FAILURE',
        critique: 'Auditor returned invalid JSON and the question cannot be auto-approved.',
      }));
    }

    const byIdx = Object.fromEntries(
      (results as AuditVerdict[]).map(r => [r.idx, r]),
    );
    return questions.map((_, i) => byIdx[i] ?? { idx: i, status: 'PASS' as const });
  } catch (error) {
    return questions.map((_, i) => ({
      idx: i,
      status: 'REJECT' as const,
      criterion: 'AUDIT_AGENT_FAILURE',
      critique: `Auditor call failed: ${(error as Error).message}`,
    }));
  }
}

function buildChunkMapByConcept(
  conceptBatch: ConceptSpec[],
  ragChunks: Record<string, ChunkRecord[]>,
): Record<string, ChunkRecord[]> {
  const out: Record<string, ChunkRecord[]> = {};
  conceptBatch.forEach(concept => {
    out[concept.id] = ragChunks[concept.id] ?? [];
  });
  return out;
}

function withEvidenceProvenance(
  question: Omit<Question, 'id' | 'created_at'>,
  conceptChunks: ChunkRecord[],
  evidenceMatchedText?: string,
): Omit<Question, 'id' | 'created_at'> {
  const provenance = inferEvidenceProvenance(question.source_quote, conceptChunks, evidenceMatchedText);
  return {
    ...question,
    chunk_id: provenance.chunkId,
    evidence_start: provenance.evidenceStart,
    evidence_end: provenance.evidenceEnd,
  };
}

function extractEvidenceMatchedText(
  conceptName: string | null,
  question: Omit<Question, 'id' | 'created_at'>,
  evidenceCorpus: string,
): string | undefined {
  const validation = buildDeterministicQuestionValidation(question, conceptName, evidenceCorpus);
  return validation.evidenceResult.evidenceMatchedText;
}

function runInlineAnswerKeyChecks(
  question: Omit<Question, 'id' | 'created_at'>,
  concept: ConceptSpec | undefined,
): InlineAuditFailure | null {
  const answerMismatch = detectExplanationAnswerMismatch(
    question.options,
    question.answer,
    question.explanation,
  );
  if (answerMismatch) {
    return {
      criterion: 'ANSWER_KEY_MISMATCH',
      critique: answerMismatch,
    };
  }

  if (!concept) return null;
  const conceptMismatch = detectConceptMismatch(
    question.stem,
    question.options[question.answer] ?? '',
    concept.name,
    concept.keyFacts ?? [],
  );
  if (conceptMismatch) {
    return {
      criterion: 'CONCEPT_MISMATCH',
      critique: conceptMismatch,
    };
  }

  return null;
}

// ─── auditQuestions — main orchestrator, verbatim from HTML ──────────────────

interface ConceptSpec {
  id: string;
  name: string;
  category: string;
  importance: string;
  keyFacts: string[];
  clinicalRelevance: string;
  associations: string[];
  pageEstimate: string;
  coverageDomain: string;
  chunk_ids: string[];
}

export async function auditQuestions(
  questions:    Array<Omit<Question, 'id' | 'created_at'>>,
  conceptBatch: ConceptSpec[],
  pdfId:        string,
  userId:       string,
  ragPassages:  Record<string, string>,
  ragChunks:    Record<string, ChunkRecord[]>,
  distractorGuides: Record<string, string>,
  onCost?: OpenAICostTracker,
): Promise<{
  passed:       Array<Omit<Question, 'id' | 'created_at'>>;
  hardRejected: HardRejected[];
  costUSD:      number;
}> {
  if (!questions.length) return { passed: [], hardRejected: [], costUSD: 0 };

  const passed: Array<Omit<Question, 'id' | 'created_at'>> = [];
  const hardRejected: HardRejected[] = [];
  let totalCost = 0;
  const chunkMapByConcept = buildChunkMapByConcept(conceptBatch, ragChunks);

  // Track questions in flight: may go through multiple revise cycles
  let inFlight = questions.map(q => ({ q, iteration: 0 }));

  for (let iter = 0; iter <= MAX_REVISE_ITERATIONS; iter++) {
    if (!inFlight.length) break;

    // Repair before validation so auto-fixable issues (mostTemptingDistractor
    // mismatch, sourceQuote paraphrase) don't generate unnecessary REVISE
    // verdicts that exhaust the revision budget.
    const repairedInFlight = inFlight.map(entry => ({
      q: repairDraftForValidation(
        entry.q as unknown as Record<string, unknown>,
        ragPassages[entry.q.concept_id] ?? '',
      ) as Omit<Question, 'id' | 'created_at'>,
      iteration: entry.iteration,
    }));

    const programmatic = repairedInFlight.map(entry => {
      const concept = conceptBatch.find(item => item.id === entry.q.concept_id);
      return buildDeterministicQuestionValidation(
        entry.q,
        concept?.name ?? null,
        ragPassages[concept?.id ?? entry.q.concept_id] ?? '',
      );
    });

    const modelAuditEligible: boolean[] = [];
    const verdicts: AuditVerdict[] = repairedInFlight.map((entry, idx) => {
      const validation = programmatic[idx]!;
      if (isCuratedPressureVolumePropertyItem(entry.q, validation)) {
        modelAuditEligible[idx] = false;
        return { idx, status: 'PASS' };
      }
      if (isLowRiskDefinitionItem(entry.q, validation)) {
        modelAuditEligible[idx] = false;
        return { idx, status: 'PASS' };
      }
      if (!validation.issues.length && validation.evidenceOk) {
        modelAuditEligible[idx] = true;
        return { idx, status: 'PASS' };
      }
      modelAuditEligible[idx] = false;
      return deterministicVerdict(idx, validation.issues);
    });

    const auditableIndices = verdicts
      .map((verdict, idx) => ({ verdict, idx }))
      .filter(entry => entry.verdict.status === 'PASS' && modelAuditEligible[entry.idx])
      .map(entry => entry.idx);

    if (auditableIndices.length) {
      const auditVerdicts = await runAuditAgent(
        auditableIndices.map(idx => repairedInFlight[idx]!.q),
        auditableIndices.map(idx => ({
          evidenceOk: programmatic[idx]!.evidenceOk,
          optionFlags: programmatic[idx]!.optionFlags,
        })),
        onCost,
      );

      auditVerdicts.forEach((verdict, localIdx) => {
        verdicts[auditableIndices[localIdx]!] = {
          ...verdict,
          idx: auditableIndices[localIdx]!,
        };
      });
    }

    const nextRound: typeof inFlight = [];

    for (let i = 0; i < inFlight.length; i++) {
      const entry = inFlight[i]!;
      const { iteration } = entry;
      const q = repairedInFlight[i]!.q;
      let v = verdicts[i]!;
      const concept = conceptBatch.find(item => item.id === q.concept_id);

      if (v.status === 'PASS') {
        const inlineFailure = runInlineAnswerKeyChecks(q, concept);
        if (inlineFailure) {
          if (iteration >= MAX_REVISE_ITERATIONS) {
            hardRejected.push({
              conceptId: q.concept_id,
              conceptName: concept?.name ?? q.concept_id,
              level: q.level,
              criterion: inlineFailure.criterion,
              critique: inlineFailure.critique,
              attempts: iteration + 1,
              lastQuestion: q,
            });
            continue;
          }

          v = {
            idx: i,
            status: 'REVISE',
            criterion: inlineFailure.criterion,
            critique: inlineFailure.critique,
          };
        }
      }

      if (v.status === 'PASS') {
        const evidenceMatchedText = extractEvidenceMatchedText(
          concept?.name ?? null,
          q,
          ragPassages[q.concept_id] ?? '',
        );
        passed.push(withEvidenceProvenance(q, chunkMapByConcept[q.concept_id] ?? [], evidenceMatchedText));
        continue;
      }

      if (v.status === 'REJECT' || iteration >= MAX_REVISE_ITERATIONS) {
        const rejectedConcept = conceptBatch.find(c => c.id === q.concept_id);
        hardRejected.push({
          conceptId:    q.concept_id,
          conceptName:  rejectedConcept?.name ?? q.concept_id,
          level:        q.level,
          criterion:    v.criterion ?? 'UNKNOWN',
          critique:     v.critique ?? 'Failed audit',
          attempts:     iteration + 1,
          lastQuestion: q,
        });
        continue;
      }

      // REVISE: send back to Writer Agent with specific critique
      try {
        const revisionConcept = concept ?? conceptBatch[0];
        if (!revisionConcept) {
          hardRejected.push({
            conceptId: q.concept_id, conceptName: q.concept_id,
            level: q.level, criterion: 'CONCEPT_MISSING',
            critique: 'Could not resolve concept for revision',
            attempts: iteration + 1, lastQuestion: q,
          });
          continue;
        }

        const passages = ragPassages[revisionConcept.id] ?? '';
        const distractorGuide = distractorGuides[revisionConcept.id] ?? '';
        const { raw: revised, costUSD } = await writerAgentRevise(
          revisionConcept,
          {
            stem: q.stem, options: q.options, answer: q.answer, level: q.level,
            pageEstimate: revisionConcept.pageEstimate,
            decidingClue: q.deciding_clue ?? undefined,
            decisionTarget: q.decision_target ?? undefined,
            mostTemptingDistractor: q.most_tempting_distractor ?? undefined,
            conceptId: q.concept_id,
          },
          v.criterion ?? '',
          v.critique ?? '',
          passages,
          distractorGuide,
          onCost,
        );
        totalCost += costUSD;

        const normed = normaliseQuestion(revised, revisionConcept, q.level, pdfId, userId);
        if (normed) {
          const evidenceCorpus = ragPassages[revisionConcept.id] ?? '';
          const evidenceMatchedText = extractEvidenceMatchedText(revisionConcept.name, normed, evidenceCorpus);
          nextRound.push({
            q: withEvidenceProvenance(normed, chunkMapByConcept[revisionConcept.id] ?? [], evidenceMatchedText),
            iteration: iteration + 1,
          });
        } else {
          hardRejected.push({
            conceptId: q.concept_id, conceptName: revisionConcept.name, level: q.level,
            criterion: v.criterion ?? 'PARSE_ERROR', critique: 'Revision returned invalid JSON',
            attempts: iteration + 1, lastQuestion: q,
          });
        }
      } catch (e) {
        const errConcept = conceptBatch.find(c => c.id === q.concept_id);
        hardRejected.push({
          conceptId: q.concept_id, conceptName: errConcept?.name ?? q.concept_id,
          level: q.level, criterion: 'WRITER_ERROR',
          critique: (e as Error).message,
          attempts: iteration + 1, lastQuestion: q,
        });
      }
    }

    inFlight = nextRound;
  }

  return { passed, hardRejected, costUSD: totalCost };
}
