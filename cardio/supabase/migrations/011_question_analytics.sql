create table public.question_attempts (
  id                  uuid primary key default uuid_generate_v4(),
  question_id         uuid not null references public.questions(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  pdf_id              uuid not null references public.pdfs(id) on delete cascade,
  selected_option     integer not null check (selected_option >= -1), -- -1 = skipped
  is_correct          boolean not null,
  time_spent_ms       integer not null,
  explanation_helpful boolean,
  flag_reason         text check (flag_reason in ('wrong_answer_key','confusing_wording','out_of_scope','other')),
  source              text not null default 'quiz' check (source in ('quiz','study')),
  created_at          timestamptz not null default now()
);

alter table public.question_attempts enable row level security;

create policy "question_attempts: users insert own rows" on public.question_attempts
  for insert with check (auth.uid() = user_id);

create policy "question_attempts: users read own rows" on public.question_attempts
  for select using (auth.uid() = user_id);

create index question_attempts_question_id_idx on public.question_attempts(question_id);
create index question_attempts_user_pdf_idx    on public.question_attempts(user_id, pdf_id);
