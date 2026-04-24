-- Migration 008: Store pipeline state between the prepare and generate calls.
-- These columns let /api/process/generate reconstruct phase-6 context without
-- re-running phases 1-5 in the same request.

ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS concept_specs         JSONB;
ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS confusion_map          JSONB;
ALTER TABLE pdfs ADD COLUMN IF NOT EXISTS effective_max_questions INT;
