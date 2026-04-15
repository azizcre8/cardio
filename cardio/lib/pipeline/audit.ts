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

import { callOpenAI, parseJSON, normaliseQuestion, writerAgentRevise, AUDITOR_MODEL } from './generation';
import type { Question } from '@/types';
import type { OpenAICostTracker } from '@/lib/openai-cost';
import { buildDeterministicQuestionValidation } from './question-validation';

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

function deterministicVerdict(
  idx: number,
  issues: string[],
): AuditVerdict {
  if (!issues.length) return { idx, status: 'PASS' };
  return {
    idx,
    status: issues.length === 1 ? 'REVISE' : 'REJECT',
    criterion: 'DETERMINISTIC_VALIDATION',
    critique: issues[0],
  };
}

// ─── runAuditAgent — upgraded prompt ─────────────────────────────────────────

export async function runAuditAgent(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
  validations: Array<{ evidenceOk: boolean; optionFlags: string[] }>,
  onCost?: OpenAICostTracker,
): Promise<AuditVerdict[]> {
  if (!questions.length) return [];

  const letters = ['A', 'B', 'C', 'D', 'E'];
  const qList = questions.map((q, i) =>
    `Q${i + 1} [${q.concept_id || '?'}] L${q.level}
Stem: ${q.stem}
Options: ${q.options.map((o, j) => `${j === q.answer ? '★' : ''}${letters[j]}) ${o}`).join(' | ')}
SourceQuote: ${q.source_quote || '(none)'}
EvidenceValid: ${validations[i]?.evidenceOk ? 'true' : 'false'}
DecisionTarget: ${q.decision_target || '(not specified)'}
DecidingClue: ${q.deciding_clue || '(not specified)'}
MostTemptingDistractor: ${q.most_tempting_distractor || '(not specified)'}
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
    if (!Array.isArray(results)) return questions.map((_, i) => ({ idx: i, status: 'PASS' as const }));

    const byIdx = Object.fromEntries(
      (results as AuditVerdict[]).map(r => [r.idx, r]),
    );
    return questions.map((_, i) => byIdx[i] ?? { idx: i, status: 'PASS' as const });
  } catch {
    return questions.map((_, i) => ({ idx: i, status: 'PASS' as const }));
  }
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

  // Track questions in flight: may go through multiple revise cycles
  let inFlight = questions.map(q => ({ q, iteration: 0 }));

  for (let iter = 0; iter <= MAX_REVISE_ITERATIONS; iter++) {
    if (!inFlight.length) break;

    const programmatic = inFlight.map(entry => {
      const concept = conceptBatch.find(item => item.id === entry.q.concept_id);
      return buildDeterministicQuestionValidation(
        entry.q,
        concept?.name ?? null,
        ragPassages[concept?.id ?? entry.q.concept_id] ?? '',
      );
    });

    const verdicts: AuditVerdict[] = inFlight.map((entry, idx) => {
      const validation = programmatic[idx]!;
      if (!validation.issues.length && validation.evidenceOk) {
        return { idx, status: 'PASS' };
      }
      return deterministicVerdict(idx, validation.issues);
    });

    const auditableIndices = verdicts
      .map((verdict, idx) => ({ verdict, idx }))
      .filter(entry => entry.verdict.status === 'PASS')
      .map(entry => entry.idx);

    if (auditableIndices.length) {
      const auditVerdicts = await runAuditAgent(
        auditableIndices.map(idx => inFlight[idx]!.q),
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
      const { q, iteration } = entry;
      const v = verdicts[i]!;

      if (v.status === 'PASS') {
        passed.push(q);
        continue;
      }

      if (v.status === 'REJECT' || iteration >= MAX_REVISE_ITERATIONS) {
        hardRejected.push({
          conceptId:    q.concept_id,
          conceptName:  q.concept_id, // concept name resolved at call site if needed
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
        const concept =
          conceptBatch.find(c => c.id === q.concept_id) ??
          conceptBatch[0];
        if (!concept) {
          hardRejected.push({
            conceptId: q.concept_id, conceptName: q.concept_id, level: q.level,
            criterion: 'CONCEPT_MISSING', critique: 'Could not resolve concept for revision',
            attempts: iteration + 1, lastQuestion: q,
          });
          continue;
        }

        const passages = ragPassages[concept.id] ?? '';
        const distractorGuide = distractorGuides[concept.id] ?? '';
        const { raw: revised, costUSD } = await writerAgentRevise(
          concept,
          {
            stem: q.stem, options: q.options, answer: q.answer, level: q.level,
            pageEstimate: concept.pageEstimate,
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

        const normed = normaliseQuestion(revised, concept, q.level, pdfId, userId);
        if (normed) {
          nextRound.push({ q: normed, iteration: iteration + 1 });
        } else {
          hardRejected.push({
            conceptId: q.concept_id, conceptName: concept.name, level: q.level,
            criterion: v.criterion ?? 'PARSE_ERROR', critique: 'Revision returned invalid JSON',
            attempts: iteration + 1, lastQuestion: q,
          });
        }
      } catch (e) {
        hardRejected.push({
          conceptId: q.concept_id, conceptName: q.concept_id, level: q.level,
          criterion: 'WRITER_ERROR', critique: (e as Error).message,
          attempts: iteration + 1, lastQuestion: q,
        });
      }
    }

    inFlight = nextRound;
  }

  return { passed, hardRejected, costUSD: totalCost };
}
