# Cardio — Migration Notes
## medical-study-app-v2.html → Next.js 14 + Supabase + Stripe

---

## What Changed (Infrastructure Only)

| Area | HTML App | Next.js App |
|---|---|---|
| Auth | None | Supabase Auth (email + Google OAuth) |
| Storage | localStorage | Supabase PostgreSQL + pgvector |
| AI calls | Client-side (apiKey in UI) | Server-side (`/api/*` routes) |
| PDF extraction | PDF.js (browser) | pdfjs-dist Node mode (server) |
| Embeddings | Truncated to 4dp for space | Full float32 (pgvector native) |
| Dense retrieval | In-memory cosine loop | Supabase `match_chunks` RPC (ivfflat) |
| Billing | None | Stripe subscriptions + webhook |
| Deployment | Single HTML file | Vercel (Next.js 14 App Router) |

---

## What Did NOT Change (Zero Logic Changes)

### SRS Formula (`lib/srs.ts`)
- `applySRS` — SM-2 modified: exact formula, exact constants, exact recovery boost
- `pickSibling` — least-recently-reviewed sibling selection, verbatim
- `buildQueue` — stratified queue (srs/weak/medium/new), cram mode thresholds, all verbatim
- Only change: `examDate` is now a function parameter instead of reading global STATE

### Pipeline Logic
- `extractTextServer` — verbatim port of `extractText()`, uses pdfjs-dist Node mode
  to preserve `item.transform[5]` y-coordinate newline detection
- `chunkText` — verbatim, including 40-word sentence-boundary extension
- `embedTexts` / `embedAllChunks` — verbatim (truncation removed — see below)
- `buildBM25Index` / `bm25Search` / `reciprocalRankFusion` — verbatim, k1=1.5, b=0.75, RRF_K=60
- `extractInventory` / `mergeInventory` / `canonicalizeConcepts` — verbatim
- `generateConfusionMap` — verbatim
- `buildConfusionCandidates` — verbatim (all 10 categories)
- `verifyEvidenceSpan` — verbatim
- `generateCoverageQuestions` — writer prompt verbatim (thousands of chars, zero edits)
- `runAuditAgent` — auditor prompt verbatim (all 11+ criteria, all verdict rules)
- `writerAgentRevise` — revision prompt verbatim
- `auditQuestions` — max 2 iteration loop, fail-closed, verbatim
- `normaliseQuestion` — Fisher-Yates shuffle, SRS initialisation, verbatim

### AI Models
- Writer: `gpt-4o` (same)
- Auditor: `gpt-4o` (same)
- Inventory/Misc: `gpt-4o-mini` (same)
- Embeddings: `text-embedding-3-small`, 512 dims (same)

---

## Intentional Differences

### 1. Embedding truncation removed
The HTML app truncates embeddings to 4 decimal places (`Math.round(v*10000)/10000`) to
reduce localStorage footprint (~3x space saving). pgvector stores float32 natively — full
precision is kept. This improves retrieval quality at no additional cost.

### 2. Dense retrieval via pgvector RPC
The HTML app's in-memory `cosineSimilarity()` loop is replaced by the `match_chunks`
Supabase RPC. BM25 sparse retrieval remains in-memory (rebuilt from DB-fetched chunks).
Fusion (RRF) is unchanged.

### 3. `examDate` parameterised in SRS calls
The original reads `STATE.examDate` globally. In Next.js:
- `applySRS(q, quality, examDate)` — server fetches from `users.exam_date`
- `buildQueue(questions, masteryData, concepts, examDate)` — fetched at API route level
- `finishDiagnostic` equivalent — fetch examDate at session start

### 4. API key removed from UI
The Settings view no longer has an OpenAI API key field. The key lives in `OPENAI_API_KEY`
server env. Students never see it.

### 5. Concept field mapping (camelCase → snake_case)
HTML localStorage used `conceptId`, `timesReviewed`, etc.
Supabase columns use `concept_id`, `times_reviewed`, etc.
The API layer merges SRS state onto Question objects before returning to the client.

---

## Known Limitations / Future Work

### Vercel timeout (boards density)
Boards-density pipeline on large PDFs (>100 pages) can exceed 300s (Vercel Pro limit).
Mitigation:
- Warn users to target ≤100 pages initially
- Long-term: move pipeline to Supabase Edge Function (Deno, no timeout)

### `optionExplanations` generated lazily
The HTML generates these on first answer reveal. Options:
1. **Upfront** (preferred): generate in pipeline, adds ~$0.002/question
2. **Lazy**: add `GET /api/study/explain?questionId=` endpoint, call on first reveal

Currently not generated upfront. Add a Phase 6b step if desired.

### Cross-deck "all due" session
The HTML's `startAllDueSession()` (pdfId = null) is not yet implemented.
Add route `/app/study/all-due` with its own queue endpoint (`/api/study/queue/all`).

### Diagnostic session
Ported as client-side logic in StudyView but the full diagnostic flow
(stratified 60/30/10 sampling, L1/L2/L3 weighting, finishDiagnostic) is simplified.
Full port would split into `DiagnosticView.tsx` matching the HTML's `startDiagnostic`.

---

## Deploy Checklist

- [ ] Apply `supabase/migrations/001_initial.sql` in Supabase SQL editor
- [ ] Enable Row Level Security on all tables (already in migration)
- [ ] Set all env vars in `.env.local` (use `.env.local.example` as template)
- [ ] Enable Supabase Auth: Email provider + Google OAuth
- [ ] Create Stripe products + price IDs, set in env
- [ ] Add Stripe webhook endpoint `https://your-domain.com/api/webhook/stripe`
  with events: `customer.subscription.created`, `updated`, `deleted`
- [ ] Deploy to Vercel (connect GitHub repo, add env vars in Vercel dashboard)
- [ ] Test with a short (10-page) PDF before going to production

---

## Source Reference

All business logic ported from:
`/Users/sajedaziz/Documents/Claude/pdf/medical-study-app-v2.html` (6494 lines)

Key line references:
- `applySRS`: line 5334
- `pickSibling`: line 4502
- `buildQueue`: line 4519
- `extractText`: line 2879
- `assessTextQuality`: line 2902
- `chunkText`: line 2925
- `embedTexts`: line 3050
- `buildBM25Index`: line 3085
- `reciprocalRankFusion`: line 3126
- `extractInventory`: line 3172
- `mergeInventory`: line 3243
- `canonicalizeConcepts`: line 3322
- `generateConfusionMap`: line 3564
- `buildConfusionCandidates`: line 3489
- `verifyEvidenceSpan`: line 3472
- `generateCoverageQuestions` (writer prompt): line 3673
- `runAuditAgent` (auditor prompt): line 3858
- `writerAgentRevise` (revision prompt): line 4047
- `auditQuestions`: line 4109
- `normaliseQuestion`: line 4071
