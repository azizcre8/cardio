-- Add item design metadata columns to questions table
alter table public.questions
  add column if not exists evidence_match_type  text
    check (evidence_match_type in ('exact','normalized','fuzzy','none')),
  add column if not exists decision_target       text,
  add column if not exists deciding_clue         text,
  add column if not exists most_tempting_distractor text,
  add column if not exists why_tempting          text,
  add column if not exists why_fails             text,
  add column if not exists option_set_flags      text[];
