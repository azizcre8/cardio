# Codex Task: Fix Question-Quality Issues Before Launch

## Context

Cardio is a Next.js 14 + Supabase medical study-app (see `CLAUDE.md` for repo layout). The 6-phase pipeline at `app/api/process/route.ts` ingests a PDF, extracts concepts, and calls `lib/pipeline/generation.ts` (writer, `gpt-4o`) → `lib/pipeline/audit.ts` (auditor, `gpt-4o`) to produce MCQs. The SM-2 SRS and all LLM prompts are **protected**: do not edit prompt templates or SRS formulas without explicit approval. Constraint rules are in `MIGRATION_NOTES.md`.

A smoke run on a 16-page Guyton chapter (`scripts/smoke-pipeline.ts`, 12 concepts) surfaced four defects that block launch. Fix them without touching protected prompts; add logic around the prompts, not inside them.

## Smoke-run evidence (from `/tmp/smoke-out.json`, 2026-04-20)

- 15 accepted / 24 generated (62.5% acceptance), cost $0.35, 0 hard-audit rejections.
- **Concept/answer mismatch accepted twice:** L1 "Hypernatremia" and L1 "Hyponatremia" stems both quote definitions of *homeostasis* — wrong concept, passed audit.
- **Non-question stem accepted:** L2 "Daily Water Intake" ends on a declarative ("Understanding his daily water intake is crucial for managing his hydration status.") with no interrogative.
- **Duplicate vignette accepted:** L2 "Edema" and L2 "Extracellular Fluid" both open "A 65-year-old man presents with swelling in his legs and shortness of breath…" and test the same mechanism.
- **Pre-audit slot failures (9/24):** 5× "option length tell" on L1, 3× "overlapping distractors," 1× "explanation justifies wrong answer."

## Deliverables

Four fixes, in this order. Each is independently shippable with tests.

---

### Fix 1 — Wire the answer-key mismatch detector into the inline audit

**Why:** `scripts/audit-answer-key-mismatches.ts` already contains `detectExplanationAnswerMismatch(options, answer, explanation)` at lines 112–148 — a string-based detector that flags when the explanation's first sentence leads with a non-keyed option. It runs offline over the DB, but the live pipeline never invokes it, so the two wrong-concept L1 questions reached `questions.flagged = false`.

**Action:**
1. Extract `detectExplanationAnswerMismatch`, `buildOptionAliases`, `normalizeText`, `normalizeOptionAlias`, `stripOptionLabel`, `singularizeToken`, `explanationMentionsAlias` into a new module `lib/pipeline/answer-key-check.ts`. Keep the logic byte-identical — no behavioral changes.
2. Update `scripts/audit-answer-key-mismatches.ts` to import from that module (delete the duplicated copies).
3. In `lib/pipeline/audit.ts`, after each question passes the LLM auditor's final accept and before it lands in `audit.passed[]`, call the detector. On a non-null result:
   - If revision iterations remain, feed the detector's message back into `writerAgentRevise` as a critique and re-audit (reuse the existing revision loop — do not add a new one).
   - If no iterations remain, push to `hardRejected` with `criterion = 'ANSWER_KEY_MISMATCH'` and the detector message as `critique`.
4. Also extend the stem-vs-concept check: the detector currently compares explanation↔options. Add a second check that the **concept name or one of its `keyFacts` aliases** appears either in the stem or in the keyed option. If neither does, reject with `criterion = 'CONCEPT_MISMATCH'`. This is what would have caught the Hypernatremia-quotes-homeostasis case.

**Test:** add `tests/answer-key-check.test.ts` with 4 cases:
- Explanation leads with correct option → pass.
- Explanation leads with distractor + positive cue → flag.
- Stem + keyed option contain no concept-name token or alias → flag as `CONCEPT_MISMATCH`.
- Stem contains concept alias (e.g. concept "Antidiuretic Hormone (ADH)", stem mentions "ADH") → pass.

---

### Fix 2 — Reject stems that aren't questions

**Why:** L2 "Daily Water Intake" had no interrogative and still passed audit. The writer occasionally emits a lead-in without a question; current validation (`lib/pipeline/question-validation.ts`) does not enforce interrogative form.

**Action:**
1. In `lib/pipeline/question-validation.ts`, add a validator `stemIsInterrogative(stem: string)` that returns `true` iff:
   - The last sentence ends with `?`, **or**
   - The last sentence starts with an interrogative lead (`which`, `what`, `how`, `why`, `when`, `where`, `identify`, `select the`, `choose the`) case-insensitive.
2. Wire it into whatever central validator collects slot-generation failures (search for the existing `"Option lengths create a test-taking tell"` reason string to locate the site). Failure reason: `"Stem is not phrased as a question."`
3. This is a pre-audit slot failure, not a post-audit hard reject — matches the existing pattern.

**Test:** `tests/question-validation.test.ts` — add cases for declarative stem (reject), `?`-terminated stem (accept), "Which of the following…" without `?` (accept), trailing citation after `?` like `"…ADH? (Chapter 25)"` (accept).

---

### Fix 3 — Dedup near-identical stems across concepts

**Why:** L2 Edema and L2 Extracellular Fluid shared the same clinical vignette. When two concepts draw from overlapping chunks, the writer converges on the same prototype patient.

**Action:**
1. After `auditQuestions` returns `passed[]` in `app/api/process/route.ts` (and in `scripts/smoke-pipeline.ts`), add a dedup pass `lib/pipeline/dedup.ts`:
   - Compute a normalized stem fingerprint: lowercase, strip punctuation, drop stop-words, keep first 12 content tokens.
   - Additionally compute cosine similarity of question embeddings (reuse `embedTexts` from `lib/pipeline/embeddings.ts`) for any two questions sharing ≥ 6 of the first 12 tokens.
   - If cosine ≥ 0.92 **or** fingerprints match exactly, keep the one whose concept has higher `importance` (high > medium > low); tiebreak by earlier `chunk_id` order. Drop the other; record it on the job's dropped-question telemetry.
2. The embedding call adds ~$0.00001/question — negligible. Batch in one `embedTexts` call.
3. Surface a count in the SSE progress stream (`data: { deduped: n }`) so the UI can report it.

**Test:** `tests/dedup.test.ts` — feed two near-identical stems with different concept IDs, assert one survives and the higher-importance one wins.

---

### Fix 4 — Kill the L1 option-length tell

**Why:** 5/9 slot failures were "option lengths create a test-taking tell," all on L1. The L1 writer prompt is producing a correct answer that is systematically longer (or shorter) than distractors. We can't edit the writer prompt, but we can enforce parity downstream.

**Action:**
1. In `lib/pipeline/distractors.ts` (or wherever the writer-output post-processor lives — grep for `buildDistractorCandidatePool`), add a `balanceOptionLengths(options, correctIdx)` helper that:
   - Measures character length of each option.
   - If max/min ratio > 1.6 **or** the correct answer is the longest/shortest by more than 30% vs. the median, return a structured signal (don't mutate).
2. Upstream of the auditor, if the signal fires, route the question through **one** `writerAgentRevise` call with the critique `"Rewrite distractors so all four options are within ±25% of the correct answer's length. Do not change the keyed option or the stem."` Use existing revision plumbing — do not add a new LLM call path.
3. If still unbalanced after the revise, slot-fail it with the existing `"Option lengths create a test-taking tell..."` reason. Keep the reason string byte-identical so the rejection-breakdown telemetry stays stable.

**Test:** `tests/option-balance.test.ts` — options `["A","B","C","This is a much longer correct answer"]` at idx 3 → signal fires; options of similar length → no signal.

---

## Out of scope (do not touch)

- Writer/auditor/inventory LLM prompts (any string literal containing the verbatim prompts in `lib/pipeline/generation.ts`, `audit.ts`, `inventory.ts`).
- SRS formulas in `lib/srs.ts`.
- Embedding model choice, chunking thresholds, retrieval fusion weights.
- Plan-tier limits.

## Verification

After all four fixes land:

```bash
set -a && source .env.local && set +a
npx tsx scripts/smoke-pipeline.ts \
  "/Users/sajedaziz/Desktop/LECOM Chapters/EXAM_3/Physiology/Physiology_Chapter25_The Body Fluid Compartments: Extracellular and Intracellular_16p.pdf" 12 \
  > /tmp/smoke-after.json
```

**Targets vs. baseline (62.5% acceptance, 0 hard rejects, 9 slot failures):**
- `hardRejectedQuestions` should now be non-zero if any questions still have concept/answer mismatch — that's the detector doing its job, not a regression.
- Zero accepted stems whose explanation leads with a non-keyed option (grep accepted `explanation` field).
- Zero accepted stems without an interrogative.
- Zero accepted stem-pairs with identical 12-token fingerprints across concepts.
- L1 "option length tell" slot failures should drop (expect ≤ 2 of 9).
- Total cost stays within 1.2× baseline ($0.35 → ≤ $0.42).

Run `npm run test:run` — all 35 existing tests + the 4 new test files must pass.

## Handoff notes

- Smoke output lives at `/tmp/smoke-out.json` (baseline) — note lines 1–12 are stderr leakage from `L3→L2 downgrade` logs; real JSON starts at line 13. Either strip the stderr at the source or document this for the next reader.
- There is no sample PDF in the repo; the Guyton chapter is at the path above on the user's Desktop.
- The offline answer-key script writes to a `flagged_questions` Supabase table — do not let the inline version write there; hard-rejected questions should never be persisted in the first place.
