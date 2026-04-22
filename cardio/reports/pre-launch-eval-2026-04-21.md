# Pre-Launch Quality Baseline — 2026-04-21

Synthesis of existing eval artifacts, used as the starting point for Phase 0 → Phase 1 work.

## Inputs

- `reports/eval-2026-04-21.json` — LLM-judge eval, 47-question physiology golden set (`physiology-cardio-bank.pdf`)
- `reports/20a-audit.md` — heuristic audit of 79 questions on `pathology-ch11a.pdf` (kidney chapter)
- `reports/20a-question-list.md` — full question dump for the same pathology PDF

## Headline numbers

| Source | Sample | Pass-quality | Notes |
|---|---|---|---|
| Physiology golden eval | 47 q | Stem 5.00, Distractor 3.89, Explanation 4.47, Evidence 4.45 | LLM judge, scale 1–5 |
| Pathology heuristic audit | 79 q | **51 flagged weak (65%)**, **5 repetitive stem pairs** | rule-based audit |

Physiology generation is in good shape. **Pathology is the actual problem** — and that's exactly the assigned-reading domain we're about to scale to.

## Failure modes ranked by frequency (pathology audit)

1. **Long source quote** — 35+ items. Evidence quotes exceed `question-validation.ts` 10-word / single-sentence cap, but they're slipping through. Either the validator isn't running on these, or its threshold isn't enforced as a hard reject.
2. **Generic attribution stem** — 12+ items. L2 vignettes default to "A 45-year-old man presents with X. Which condition is most likely responsible?" Pattern collapses across many concepts → effectively interchangeable stems.
3. **L1 template over-fire on pathology** — 15+ L1 items. Despite commit `4b2df97`, "In the source passage, which named concept is described by..." is still the L1 default for pathology content. The fix changed `definition_recall` → `entity_recall` defaulting; need to verify it actually flipped for non-physio domains.
4. **Missing `evidence_match_type`** — 9 items with `null`. Validation gap, not a generation gap — these should be repaired or rejected before write.
5. **Off-chapter drift** — 2 items (Urothelial Carcinoma, Nephrolithiasis appearing in glomerular-disease chapter). Inventory phase is letting tangentially-related concepts in.
6. **Repetitive stem pairs** — 5 pairs above 0.6 similarity, 2 above 0.8. All are L1 entity-recall stems on same/adjacent concepts. Today's dedup clusters by stem similarity, but these *are* similar stems — so either the threshold is too loose or the pass isn't running.

## Repetition root cause (your symptom)

The five flagged pairs from `20a-audit.md` confirm: dedup runs but the threshold is too permissive. Pairs at 0.79 and 0.82 cosine are clearly redundant. Recommend lowering the L1 entity-recall dedup threshold to ~0.55 and/or hashing on the *answer concept* (not stem text) for L1 since the L1 template is intentionally formulaic.

## Targets for Phase 1

| Fix | File | Acceptance |
|---|---|---|
| Hard-reject evidence quotes >25 words OR >1 sentence | `lib/pipeline/question-validation.ts` | Re-audit pathology PDF: "long source quote" count → 0 |
| Lower L1 entity-recall dedup threshold OR cluster by answer concept | `lib/pipeline/dedup.ts` | Re-audit: repetitive pairs >0.6 → 0 |
| Verify `entity_recall` default actually applies to non-physio domains | `lib/pipeline/generation.ts` | Spot-check pathology run: <30% of L1 use the "named concept is described by" template |
| Diversify L2 vignette openers (age/presentation/chief complaint variation) | `lib/pipeline/generation.ts` (writer prompt) — flag prompt change for user review | Re-audit: "generic attribution stem" count cut by 50% |
| Fail-fast on `evidence_match_type === null` | `lib/pipeline/question-validation.ts` | Re-audit: missing-evidence count → 0 |
| Tighten inventory off-chapter filter | `lib/pipeline/inventory.ts` | Re-audit: off-chapter drift → 0 |

Note on row 4: L2 vignette diversification touches the writer prompt, which CLAUDE.md treats as zero-changes-allowed without explicit instruction. Cron should NOT apply this without your sign-off.

## Cost reference (for Phase 5)

- Eval judge cost on 47-question physiology set: **$0.0082**
- Need: per-PDF generation cost from `pdf_jobs.openai_cost_usd` for the 20a pathology run (~79 questions). To extract once cron / human runs `scripts/estimate-pdf-cost.ts` on it.

## Next actions for the autonomous cron

In order of safety (do top-down):

1. Add hard-reject for long evidence quotes (`question-validation.ts`) — pure validator change, no prompt edit.
2. Lower L1 dedup threshold (`dedup.ts`) — pure config/threshold change.
3. Add fail-fast on null `evidence_match_type` (`question-validation.ts`).
4. Verify and (if needed) re-fix the L1 template default for pathology in `generation.ts` (config-side only, not the prompt body).
5. Re-run the audit script on `pathology-ch11a.pdf` after each change; append numbers to this file.

Stop and wait for user input before:
- Editing any LLM prompt template
- Editing the inventory off-chapter filter (semantic risk; needs eyes)
