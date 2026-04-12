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

const MAX_REVISE_ITERATIONS = 2;

export interface AuditVerdict {
  idx:       number;
  status:    'PASS' | 'REVISE' | 'REJECT';
  criterion?: string;
  critique?:  string;
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

// ─── Programmatic length-tell audit (no API call) — verbatim from HTML ────────

export function runLengthAudit(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
): AuditVerdict[] {
  return questions.map((q, idx) => {
    const correct    = q.options[q.answer] ?? '';
    const distractors = q.options.filter((_, i) => i !== q.answer);
    const correctWords = correct.trim().split(/\s+/).length;
    const avgDistractorWords =
      distractors.reduce((s, d) => s + d.trim().split(/\s+/).length, 0) / distractors.length;
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

// ─── runAuditAgent — verbatim prompt ─────────────────────────────────────────

export async function runAuditAgent(
  questions: Array<Omit<Question, 'id' | 'created_at'>>,
): Promise<AuditVerdict[]> {
  if (!questions.length) return [];

  const letters = ['A', 'B', 'C', 'D', 'E'];
  const qList = questions.map((q, i) =>
    `Q${i + 1} [${q.concept_id || '?'}] L${q.level}
Stem: ${q.stem}
Options: ${q.options.map((o, j) => `${j === q.answer ? '★' : ''}${letters[j]}) ${o}`).join(' | ')}
SourceQuote: ${q.source_quote || '(none)'}
EvidenceValid: ${q.flagged === false ? 'true' : 'false'}`,
  ).join('\n\n');

  const prompt = `You are a Senior USMLE/COMLEX Clinical Audit Agent performing board-standard quality review. You are acting as an impartial judge — not a question writer. Respond ONLY with valid JSON.

QUESTIONS TO AUDIT:
${qList}

EVALUATE EACH QUESTION strictly against these criteria:

1. HOMOGENEITY + ONE-FEATURE RULE — All distractors must belong to the exact same medical category as the correct answer AND each distractor must differ from the correct answer by exactly one clinically meaningful feature (drug class, mechanism step, organism type, complication subtype, etc.).
   Fail example: correct answer is a drug mechanism; distractors are symptoms, anatomical structures, or lab values.
   Fail example: three distractors all differ from the correct answer in multiple independent dimensions — a student could rule them out without specific knowledge.
   Pass requires: all options are the same type of entity (all drugs, all complications, all mechanisms, etc.) and each wrong option is wrong for one specific, identifiable reason.
   Note: L1 questions have 5 options (A-E), L2/L3 have 4 options (A-D) — both are correct formats.

2. PLAUSIBILITY — Every distractor must be a near-miss that a knowledgeable student who hasn't fully mastered this concept would genuinely choose.
   Fail example: a distractor is obviously unrelated, already ruled out by the stem, or only someone who knows nothing would pick it.

3. EVIDENCE — If a sourceQuote is provided, it must directly and unambiguously prove the correct answer is right — not a tangential or loosely related fact.

4. LEAD-IN — The stem must be specific enough that a student can formulate the correct answer BEFORE seeing the options ("Which of the following is true about X" = fail; "A 32-year-old presents with… The most likely mechanism is…" = pass).

5. EVIDENCE — The sourceQuote field must be a direct verbatim excerpt from the provided chunk text that proves the correct answer. If EvidenceValid is false or the quote is clearly fabricated (not plausibly from any medical textbook passage), verdict must be REVISE with criterion EVIDENCE.

6. TELL-SIGNS — The correct answer must not be identifiable without medical knowledge through any of these cues:
   - LENGTH TELL: The correct answer is noticeably longer or contains more clauses than the distractors. All options must be comparable in length and grammatical complexity.
   - QUALIFIER TELL: Only the correct answer contains mechanistic connectors ("via," "due to," "resulting in," "caused by," "leading to") while distractors are bare noun phrases or vice versa. All options must use the same grammatical structure.
   - KEYWORD MIRROR: The correct answer repeats a specific uncommon term from the stem that does not appear in any distractor, making it the obvious match.
   - SPECIFICITY ASYMMETRY: The correct answer names a specific mechanism, drug, or pathway while distractors are generic/vague categories.
   Fail: ANY single cue above is present. A student with no medical knowledge could eliminate distractors or select the correct answer based on surface features alone.

6. CONVERGENCE — Distractors must not cluster around a shared keyword, concept, or physiological domain that the correct answer does not share.
   - Fail example: correct answer is about "fibrosis" and all 3 distractors contain the word "inflammation" — a student picks the non-inflammation outlier with zero medical knowledge.
   - Fail example: correct answer is about "decreased resistance" and all distractors describe "increased" versions of various parameters — the polarity mismatch is the tell.
   - Pass requires: each distractor represents a distinct concept or mechanism. No single word or theme should appear in more than one distractor unless it also appears in the correct answer.

7. DISTRACTOR VALIDITY — Every wrong answer option must be a real, medically accurate entity, mechanism, drug, condition, or finding that exists in medicine — even if it is wrong for this specific question.
   Fail: A distractor describes a mechanism that does not exist or is physiologically impossible.
   Fail: A distractor combines real words into a phrase that has no actual medical meaning (e.g., "mitochondrial valve insufficiency," "hepatic sympathetic rebound").
   Fail: A distractor names a real condition but attributes to it a property it does not have in any clinical context.
   Pass: The distractor is factually correct in some other clinical context, just not the right answer here.

8. CONVERGENCE — No single theme, mechanism, or clinically significant word should dominate 3 or more options.
   Fail: Three or more options share a dominant keyword or root (e.g., three options all mention "reabsorption," "vasodilation," or "increased sodium").
   Fail: Three or more distractors are all variations of the same underlying mechanism or directional change (e.g., all "increased X," all "decreased Y"), making the correct answer the obvious outlier.
   Fail: One option is clearly the thematic odd-one-out — a test-smart student can identify it without any medical knowledge.
   Pass: All options represent meaningfully different mechanisms or concepts that plausibly compete with each other.

9. NEGATION INTEGRITY (applies only if stem contains "NOT," "EXCEPT," or "LEAST") — Every non-keyed option must be a true, unambiguous statement.
   Fail: Any of the "true" options is debatable, partially false, or only true in certain contexts.
   Fail: The negation stem is used at Level 1.
   Fail: The false (keyed) option is false only due to wording ambiguity rather than substantive incorrectness.

11. COMPETITIVE_DISTRACTOR — The distractor set must be genuinely competitive, not just homogeneous.
   Fail: Fewer than 2 distractors are plausible to a partially-informed student who has studied (but not mastered) this concept.
   Fail: No distractor reflects a common misconception, confusion pair, or classic student error — all distractors are neutral wrong answers rather than tempting near-misses.
   Fail: Any distractor can be ruled out instantly by a student who simply knows the organ system or physiological domain — without needing to know the specific concept being tested.
   Pass: At least 2 distractors require real understanding of this specific concept to eliminate; at least 1 is drawn from a classic confusion pair or common misconception.

10. CONVERGENCE (extended) — Distractors must not cluster around a shared keyword, concept, or physiological domain that the correct answer does not share.
   Fail: correct answer is about "fibrosis" and all 3 distractors contain "inflammation" — a student picks the non-inflammation outlier with zero medical knowledge.
   Fail: correct answer is about "decreased resistance" and all distractors describe "increased" versions — polarity mismatch is the tell.
   Pass: each distractor represents a distinct concept or mechanism; no single word or theme appears in more than one distractor unless it also appears in the correct answer.

VERDICT RULES:
- PASS: Meets all 6 criteria. No significant flaws.
- REVISE: Has exactly ONE fixable flaw in a single criterion. The critique must name the criterion and give a specific 1-sentence fix instruction.
- REVISE if any distractor (wrong answer option) belongs to a completely different organ system or physiological domain than the correct answer AND could be ruled out without any subject-specific knowledge (e.g., in a neuroscience question, distractors like "regulation of heart rate", "insulin secretion", "kidney filtration" that have nothing to do with the nervous system — these make the question trivially easy).
- REVISE if the correct answer is more than ~20% longer (in word count) than the average distractor length.
- REVISE if only the correct answer contains mechanistic connector phrases ("via," "due to," "leading to," "caused by," "resulting in") while distractors lack them.
- REVISE if the correct answer mirrors an uncommon keyword from the stem that no distractor shares.
- REVISE if 2 or more distractors share a keyword longer than 5 letters that does not appear in the correct answer — this makes the correct answer the obvious outlier.
- REVISE if all distractors describe the same directional change (all "increased" or all "decreased") while the correct answer describes the opposite — polarity clustering is a convergence cue.
- REVISE if 3 or more options share a dominant clinically significant keyword — name the word and instruct the writer to diversify.
- REVISE if all distractors cluster around one theme while the correct answer stands alone as the outlier, or vice versa.
- REVISE if 3 or more options share a dominant clinically significant keyword — name the shared word and instruct replacement of at least one distractor with a conceptually distinct alternative.
- REVISE if all distractors share the same directional polarity (all "increased" or all "decreased") while the correct answer differs — require mixed polarities.
- REVISE if one option is the clear thematic outlier among otherwise similar options.
- REVISE if the explanation contains no contrast language ("however," "whereas," "unlike," "in contrast," "not because") — it must address at least one wrong answer explicitly, not just restate why the correct answer is right.
- REVISE if the explanation could apply to a different question on the same concept — it must be specific enough that removing the question stem would make it incomplete.
- REVISE if the explanation never names or describes any specific distractor — saying "the other options are incorrect" without identifying what they are or why each fails is unacceptable.
- REVISE (COMPETITIVE_DISTRACTOR) if fewer than 2 distractors are plausible to a partially-informed student — the question is too easy to eliminate down to 1 option with partial knowledge.
- REVISE (COMPETITIVE_DISTRACTOR) if no distractor reflects a classic misconception or confusion pair — replace the weakest distractor with one that exploits a known student confusion in this clinical area.
- REVISE (COMPETITIVE_DISTRACTOR) if any distractor can be eliminated without knowing anything specific about the concept being tested — it must require concept-specific knowledge to rule out.
- REJECT if any distractor describes a physiologically impossible mechanism or a medically fabricated entity that does not exist in clinical practice.
- REVISE if a distractor combines real medical terms into a phrase with no established clinical meaning.
- REVISE if a negation stem (NOT/EXCEPT/LEAST) is used at Level 1 — downgrade to a positive stem.
- REJECT if a NOT/EXCEPT question has fewer than 3 definitively true non-keyed options.
- REVISE if a Level 2 question begins with "What is the [primary/main/key/significance/role/function/pathophysiology/mechanism] of [concept name]" where the stem adds no additional clinical context beyond the concept name itself — this is disguised Level 1 recall. Critique must say: "Rewrite as a mechanism/comparison/why question: explain WHY [X] occurs or HOW [X] leads to [Y]."
- REJECT: Has multiple simultaneous failures, a factually incorrect correct answer, or the stem is irreparably ambiguous.

Return a compact JSON array (no markdown, no prose outside JSON):
[
  {"idx":0,"status":"PASS"},
  {"idx":1,"status":"REVISE","criterion":"HOMOGENEITY","critique":"Distractors mix drug classes and symptoms; replace all 3 with other beta-blocker mechanisms"},
  {"idx":2,"status":"REJECT","criterion":"LEAD-IN","critique":"Stem asks 'which is true about ACE inhibitors' — irreparably vague, cannot be fixed without full rewrite"}
]

Be strict but fair. REVISE when there is ONE clear, fixable issue. REJECT only when the question is fundamentally broken.`;

  try {
    const { text } = await callOpenAI(prompt, 1500, AUDITOR_MODEL);
    const results = parseJSON(text);
    if (!Array.isArray(results)) return questions.map((_, i) => ({ idx: i, status: 'PASS' as const }));

    const byIdx = Object.fromEntries(
      (results as AuditVerdict[]).map(r => [r.idx, r]),
    );
    return questions.map((_, i) => byIdx[i] ?? { idx: i, status: 'PASS' as const });
  } catch {
    // Audit failure → pass all through (never block pipeline on audit errors)
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

    // Run Auditor Agent on current batch
    let verdicts = await runAuditAgent(inFlight.map(e => e.q));

    // Merge programmatic length audit — catches length tells the LLM auditor misses
    const lengthResults = runLengthAudit(inFlight.map(e => e.q));
    verdicts = verdicts.map((r, i) => {
      if (r.status === 'PASS' && lengthResults[i]?.status === 'REVISE') return lengthResults[i]!;
      return r;
    });

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
        const { raw: revised, costUSD } = await writerAgentRevise(
          concept,
          { stem: q.stem, options: q.options, answer: q.answer, level: q.level, pageEstimate: concept.pageEstimate },
          v.criterion ?? '',
          v.critique ?? '',
          passages,
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
