# Cardio — Shared Agent Context

Medical study app: Next.js 14 App Router + Supabase + OpenAI.  
Converts uploaded PDFs into spaced-repetition question banks.

---

## Dev Server — Critical Rule

**Never start a dev server manually from a terminal.**  
The preview tool manages the server. Two concurrent `npm run dev` processes will race to delete each other's `.next` cache and cause "Cannot find module './NNN.js'" errors.

```
npm run dev         # normal start — safe, no cache wipe
npm run dev:clean   # only use when you need a full cache rebuild (e.g. after dep changes)
npm run test:run    # run all Vitest unit tests
npm run db:migrate  # apply Supabase SQL migrations
```

---

## Repo Layout

```
cardio/
├── app/                    # Next.js App Router
│   ├── api/process/        # POST — full 6-phase PDF pipeline (SSE stream)
│   ├── api/pdfs/           # PDF CRUD + concepts/questions sub-routes
│   ├── api/study/          # queue (GET) + submit (POST) for SRS
│   ├── api/decks/          # Deck hierarchy CRUD
│   ├── api/shared-banks/   # Shared bank publish/join
│   ├── api/webhook/stripe/ # Stripe subscription events
│   ├── app/                # Authenticated shell (views: library/quiz/stats/etc.)
│   └── page.tsx            # Public landing page
├── components/             # React client components (AppContent, QuizView, etc.)
├── lib/
│   ├── pipeline/           # 6-phase processing (ingestion → chunking → embed → inventory → generation → audit)
│   ├── storage.ts          # All Supabase CRUD (single source of truth)
│   ├── auth.ts             # requireUser() — use in every API route
│   ├── srs.ts              # SM-2 spaced repetition (applySRS, buildQueue)
│   ├── plans.ts            # getPlanLimits() per plan tier
│   ├── env.ts              # Env vars + feature flags (ENABLE_*)
│   ├── openai-cost.ts      # Token → USD cost tracking
│   └── pdf-jobs.ts         # Processing job lifecycle
├── supabase/migrations/    # SQL files — run via npm run db:migrate
├── tests/                  # Vitest unit tests (mirrors lib/pipeline/)
├── types/index.ts          # Single source of truth for all types
└── scripts/                # One-off utilities (cost estimates, margin projections)
```

---

## Pipeline (6 Phases) — `/api/process` POST

All phases run sequentially; progress emitted as SSE `ProcessEvent` objects.

| Phase | File | What it does |
|-------|------|-------------|
| 1 | `pipeline/ingestion.ts` | PDF bytes → pages of text |
| 2 | `pipeline/chunking.ts` | Pages → overlapping text chunks |
| 3 | `pipeline/embeddings.ts` | Chunks → `text-embedding-3-small` vectors → Supabase |
| 4 | `pipeline/retrieval.ts` | Build in-memory BM25 index for RAG |
| 5a | `pipeline/inventory.ts` | LLM extracts concepts → dedup → confusion map |
| 5b/6 | `pipeline/generation.ts` | Writer agent (gpt-4o) generates questions per concept/level |
| 6b | `pipeline/audit.ts` | Auditor agent (gpt-4o) validates; ≤2 revision loops |

Supporting files: `distractors.ts`, `question-validation.ts`, `validation.ts`, `slots.ts`

---

## Database (Supabase + pgvector)

Key tables: `users`, `pdfs`, `chunks` (+ embeddings), `concepts`, `questions`, `srs_state`, `reviews`, `pdf_jobs`, `decks`, `shared_banks`, `shared_bank_members`, `flagged_questions`

- All tables have RLS; every query is user-scoped via `auth.uid() = user_id`
- `chunks.embedding` — float32, 512-dim (text-embedding-3-small)
- `match_chunks()` RPC — pgvector ivfflat similarity search
- `get_deck_tree()` RPC — recursive CTE for full deck hierarchy
- Migrations in `supabase/migrations/` numbered 001–007

**Storage layer rule:** always go through `lib/storage.ts`. Never write inline Supabase queries in route handlers.

---

## Auth

- Supabase Auth (email/password + Google OAuth)
- `middleware.ts` — redirects unauthenticated users away from `/app/*`
- Every API route must call `requireUser()` from `lib/auth.ts` at the top

---

## Types

All types live in `types/index.ts`. Key ones:
- `Question` — stem, options[4|5], answer index, evidence metadata, item-design fields
- `Concept` — name, category, importance (high/medium/low), keyFacts, aliases
- `ChunkRecord` — text, embedding, start_page/end_page
- `DENSITY_CONFIG` — per-density word/overlap/level settings
- `ProcessEvent` — SSE payload (phase, message, pct, data?)

---

## Feature Flags (`lib/env.ts`)

All default `true` unless set to `false` in `.env.local`:

| Flag | Controls |
|------|---------|
| `ENABLE_TEXT_QUALITY_CHECK` | Reject scanned/image PDFs |
| `ENABLE_EVIDENCE_GATING` | Require verified source quote |
| `ENABLE_HYBRID_RETRIEVAL` | BM25 + pgvector RRF fusion |
| `ENABLE_STRUCTURAL_CHUNKING` | Heading-aware chunking |
| `ENABLE_FUZZY_EVIDENCE_MATCH` | Sliding-window evidence match |
| `ENABLE_NEGATIVE_RAG` | Exclude near-synonym distractors |
| `ENABLE_L3_GROUNDING_GUARD` | Downgrade L3→L2 if no clinical context |
| `ENABLE_SLOT_BASED_GENERATION` | Slot budget cap (prevents runaway pipelines) |

---

## Plan Tiers & Limits

| Tier | PDFs/month | Max questions/PDF |
|------|-----------|-------------------|
| free | 2 | 50 |
| student | 20 | 300 |
| boards | ∞ | 500 |
| institution | ∞ | 500 |

Defined in `types/index.ts` → `PLAN_LIMITS`. Read via `getPlanLimits()` in `lib/plans.ts`.

---

## Required Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
# Billing (optional):
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_STUDENT_PRICE_ID
STRIPE_BOARDS_PRICE_ID
```

---

## Coding Conventions

- **API routes** — always `requireUser()` first, always return via `lib/api.ts` helpers (`jsonOk`, `jsonError`)
- **Storage** — all DB access through `lib/storage.ts`; no inline Supabase calls elsewhere
- **Pipeline** — each phase is a pure function; side effects (DB writes) happen in the route handler
- **Cost tracking** — pass `onCost` callback through every OpenAI call; it updates `pdf_jobs` in real time
- **Tests** — Vitest; test files in `tests/`, mirror pipeline module names; run `npm run test:run` before committing
- **Migrations** — add numbered SQL files to `supabase/migrations/`; run `npm run db:migrate`
- **Types** — add to `types/index.ts`, never create local type files

---

## SRS (Spaced Repetition)

SM-2 algorithm in `lib/srs.ts`:
- Quality 1–4 per review; quality ≥ 3 = success
- `applySRS()` — compute next interval + ease factor; tightens near exam date
- `buildQueue()` — stratified pull from 4 buckets: srs-due, weak, medium, new
- Study queue endpoint: `GET /api/study/queue`; submit: `POST /api/study/submit`
