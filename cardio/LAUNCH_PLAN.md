# Cardio — Pre-Launch Finish Plan

## Context

You want to ship Cardio in two phases:

1. **Class beta (immediate):** upload remaining assigned-reading PDFs yourself, generate question banks, share them with your class via public link, collect feedback. Goal: validate quality + gather pricing data on your own generation costs.
2. **Public SaaS (after data):** open paid self-serve generation once you've priced it from real cost telemetry.

Two blockers stand between us and (1):

- **Question quality.** Latest commits (`4b2df97` L1 template fix, `1244bc9` dedup, `05b8174` evidence grounding) haven't been validated end-to-end. Repetitive answers were the user-visible symptom.
- **Library UX.** Deck nesting works in DB but the sidebar is text-heavy, drag-drop feedback is weak, hover-only actions break on touch — not what an Anki user expects.

Plus a deployment/sharing path that's wired but not exercised, and you want autonomous continuation overnight via cron.

---

## Phase 0 — Validate current generation quality (do first, before any code changes)

Critical: we don't know if the latest commits actually fixed repetition. Measure before changing.

1. Run `cardio/scripts/eval-against-reference.ts` and `cardio/scripts/compare-generation.ts` on 1–2 of your already-processed PDFs. Capture:
   - Answer-text duplication rate (substring + embedding similarity)
   - Distractor uniqueness across questions in same deck
   - L1/L2/L3 distribution
   - Boards-mode rejection rate
2. Eyeball ~30 questions per PDF for repetitive *correct answers* (the symptom you flagged — likely a dedup-by-stem-only bug, not a distractor bug).
3. Drop a short report at `cardio/reports/pre-launch-eval-2026-04-21.md`.

**Files:** `cardio/lib/pipeline/{dedup.ts,question-validation.ts,offline-comparison.ts}`, `cardio/scripts/eval-against-reference.ts`.

---

## Phase 1 — Fix the question-quality issues the eval surfaces

Likely fixes (confirm with Phase 0 data):

- **Repetitive correct answers:** extend dedup in `lib/pipeline/dedup.ts` to cluster by *answer-text embedding*, not just stem. Today's clustering is coverage-aware but answer-side similarity isn't a hard gate.
- **Weak distractors:** verify `ENABLE_NEGATIVE_RAG` is actually firing and the confusion-pair pool has >= N candidates per concept; add a metric to the eval report.
- **L1 over-fire on non-physiology:** spot-check the `4b2df97` fix on a non-physio PDF (one of your assigned readings).
- **Boards-mode rejection rate:** if eval shows >30% rejection, loosen the auditor's deterministic verdict rules (`lib/pipeline/audit.ts:47–150`) for that mode only.

Re-run Phase 0 eval after each change. Don't ship without a clean delta.

---

## Phase 2 — Library UX (Anki-style)

Sidebar deck tree already supports nesting + drag-drop in `cardio/components/LibrarySidebar.tsx`, but the UX is rough. Targeted polish, not a rewrite:

1. **Visual hierarchy:** indent guides (faint vertical lines per depth), tighter rows, fold/unfold chevron on the row itself.
2. **Drag-drop feedback:** drag ghost preview, drop-zone highlight on hover, auto-expand target deck after ~700ms hover, error toast when drop is rejected (e.g., circular parent).
3. **Always-visible actions:** replace hover-only `+ ✎ ✕` with a right-side affordance that's visible on focus / touch. Add keyboard: `n` = new subdeck under selection, `r` = rename, `Del` = delete.
4. **PDF→subdeck drop:** allow dropping a PDF onto a collapsed deck (auto-expand on hover) and into nested subdecks.
5. **Within-deck reorder:** expose the existing `position` field via drag handle.

**Files:** `cardio/components/LibrarySidebar.tsx`, `LibraryView.tsx`, `globals.css`. Don't touch the API; reorder/move endpoints already exist.

Out of scope for v1: multi-select drag, keyboard tree navigation beyond basics.

**Keep:** the existing EKG loading bar in the Processing view — do not replace it with a generic progress bar. If we need more phase clarity, layer phase labels under/around the EKG, don't swap it out.

---

## Phase 3 — Class sharing flow

The `shared_banks` table + `/api/shared-banks` route + slug-based join already exist. What's missing is a clean classroom UX:

1. **"Share with class" button** on each PDF/deck in LibraryView → generates slug, copies link, shows a toast with the URL.
2. **Public landing for shared bank** (`/s/[slug]`) — preview metadata (PDF title, # questions, owner), one-click "Add to my library" (auth gate → creates membership).
3. **Owner dashboard:** small panel on the shared bank showing # joiners + a feedback link (Google Form URL field on the share record is fine for v1 — don't build in-app feedback).
4. **Revoke / unpublish** control.

**Files:** `cardio/app/api/shared-banks/route.ts`, new `cardio/app/s/[slug]/page.tsx`, `LibraryView.tsx`.

---

## Phase 4 — Deploy to Vercel + verify Stripe

1. Push to `main`, deploy to Vercel, wire all 13 env vars from `.env.example` (Supabase, OpenAI, Stripe).
2. Run Supabase migrations against the prod project; verify RLS.
3. Stripe: test webhook in prod with a real test-mode subscription, confirm `users.plan` flips.
4. Smoke test the full path on prod: signup → upload PDF → generate → share → join from second account.
5. Custom domain + basic analytics (Vercel Analytics is enough for now).

---

## Phase 5 — Pricing data collection (no code, just instrumentation review)

Before opening paid self-serve, you need cost-per-PDF data. `pdf_jobs.openai_cost_usd` already records this. Action items:

1. Add a tiny admin query / script that exports `(pdf pages, density, total cost, # questions)` rows for every PDF you generate during the class beta.
2. After ~20 PDFs across densities, fit a simple model (cost ≈ a + b·pages + c·density_multiplier) and use that to set tier prices.
3. Defer institution-tier seat/metering until you have a customer asking.

---

## Phase 6 — Overnight autonomy (cron)

You want me to keep working when you're asleep / when this window closes. Plan:

- Use the `schedule` skill / `CronCreate` to register a remote agent that fires every N hours with a self-contained prompt: "Read `/Users/sajedaziz/.claude/plans/okay-i-m-going-to-zazzy-star.md`, find the next unchecked task, do it, commit, update the plan with status."
- Keep a `## Progress log` section at the bottom of this plan; the cron agent appends to it so you can audit overnight work in the morning.
- Cap autonomous scope: only Phase 0 → 2 work runs unattended. Phase 3 (sharing UX), Phase 4 (deploy), Phase 5 (pricing) require your eyes.

**To set up:** I need from you (a) cadence — every 2h, 4h, daily? and (b) confirmation it's OK to commit + push from the autonomous agent. I'll set this up right after you approve the plan.

---

## Critical files to know

- Generation: `cardio/lib/pipeline/{generation.ts, audit.ts, distractors.ts, dedup.ts, question-validation.ts}`
- Eval: `cardio/lib/pipeline/{eval-judge.ts, offline-comparison.ts}`, `cardio/scripts/{eval-against-reference.ts, compare-generation.ts}`
- Library UI: `cardio/components/{LibrarySidebar.tsx, LibraryView.tsx, ui.tsx}`, `cardio/app/globals.css`
- Sharing: `cardio/app/api/shared-banks/route.ts`, `cardio/lib/shared-banks.ts` (if present)
- Cost telemetry: `cardio/lib/pdf-jobs.ts`, `cardio/lib/openai-cost.ts`

## Verification per phase

- **Phase 0/1:** eval report at `cardio/reports/pre-launch-eval-*.md` shows answer-dup rate < 5%, distractor uniqueness > 0.85.
- **Phase 2:** manual run of `npm run dev`, drag a PDF into a 3-level-nested deck, verify ghost + auto-expand + toast.
- **Phase 3:** create share link in account A, join from account B in incognito, confirm bank appears.
- **Phase 4:** prod URL serves a generated bank end-to-end; Stripe test sub flips plan.

## Progress log

(Cron agent appends here.)
