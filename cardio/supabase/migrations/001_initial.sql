-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "vector";

-- ─── Users / Profiles ────────────────────────────────────────────────────────

create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  plan          text not null default 'free'
                  check (plan in ('free','student','boards','institution')),
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  exam_date               date,
  pdfs_this_month         integer not null default 0,
  month_reset_at          timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users: own row" on public.users
  for all using (auth.uid() = id);

-- Auto-create profile on sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─── PDFs ────────────────────────────────────────────────────────────────────

create table public.pdfs (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references public.users(id) on delete cascade,
  name                  text not null,
  page_count            integer not null default 0,
  density               text not null default 'standard'
                          check (density in ('standard','comprehensive','boards')),
  created_at            timestamptz not null default now(),
  processed_at          timestamptz,
  processing_cost_usd   numeric(10,6),
  concept_count         integer,
  question_count        integer
);

alter table public.pdfs enable row level security;

create policy "pdfs: own rows" on public.pdfs
  for all using (auth.uid() = user_id);

create index pdfs_user_id_idx on public.pdfs(user_id);

-- ─── Chunks ───────────────────────────────────────────────────────────────────

create table public.chunks (
  id          text primary key,                       -- "{pdfId}_chunk_{i}"
  pdf_id      uuid not null references public.pdfs(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  text        text not null,
  start_page  integer not null,
  end_page    integer not null,
  headers     text[] not null default '{}',
  word_count  integer not null default 0,
  embedding   vector(512),
  created_at  timestamptz not null default now()
);

alter table public.chunks enable row level security;

create policy "chunks: own rows" on public.chunks
  for all using (auth.uid() = user_id);

create index chunks_pdf_id_idx on public.chunks(pdf_id);

-- IVFFlat index for approximate nearest neighbor search
-- lists = sqrt(expected_row_count); tune after data grows
create index chunks_embedding_idx on public.chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ─── Concepts ─────────────────────────────────────────────────────────────────

create table public.concepts (
  id                uuid primary key default uuid_generate_v4(),
  pdf_id            uuid not null references public.pdfs(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  name              text not null,
  category          text not null,
  importance        text not null check (importance in ('high','medium','low')),
  summary           text not null default '',
  coverage_domains  text[] not null default '{}',
  chunk_ids         text[] not null default '{}',
  aliases           text[] not null default '{}',
  confusion_targets text[] not null default '{}',
  created_at        timestamptz not null default now()
);

alter table public.concepts enable row level security;

create policy "concepts: own rows" on public.concepts
  for all using (auth.uid() = user_id);

create index concepts_pdf_id_idx on public.concepts(pdf_id);

-- ─── Questions ───────────────────────────────────────────────────────────────

create table public.questions (
  id                   uuid primary key default uuid_generate_v4(),
  pdf_id               uuid not null references public.pdfs(id) on delete cascade,
  concept_id           uuid not null references public.concepts(id) on delete cascade,
  user_id              uuid not null references public.users(id) on delete cascade,
  level                integer not null check (level in (1,2,3)),
  stem                 text not null,
  options              text[] not null,
  answer               integer not null,               -- 0-indexed
  explanation          text not null default '',
  option_explanations  text[],
  source_quote         text not null default '',
  evidence_start       integer,
  evidence_end         integer,
  chunk_id             text references public.chunks(id) on delete set null,
  flagged              boolean not null default false,
  flag_reason          text,
  created_at           timestamptz not null default now()
);

alter table public.questions enable row level security;

create policy "questions: own rows" on public.questions
  for all using (auth.uid() = user_id);

create index questions_pdf_id_idx    on public.questions(pdf_id);
create index questions_concept_id_idx on public.questions(concept_id);

-- ─── SRS State ───────────────────────────────────────────────────────────────

create table public.srs_state (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  question_id     uuid not null references public.questions(id) on delete cascade,
  pdf_id          uuid not null references public.pdfs(id) on delete cascade,
  interval        numeric(10,4) not null default 0.17,  -- days
  ease_factor     numeric(5,4)  not null default 2.5,
  repetitions     integer       not null default 0,
  next_review     timestamptz   not null default now(),
  last_reviewed   timestamptz   not null default now(),
  times_reviewed  integer       not null default 0,
  times_correct   integer       not null default 0,
  times_incorrect integer       not null default 0,
  quality_history integer[]     not null default '{}',
  updated_at      timestamptz   not null default now(),

  unique (user_id, question_id)
);

alter table public.srs_state enable row level security;

create policy "srs_state: own rows" on public.srs_state
  for all using (auth.uid() = user_id);

create index srs_state_user_pdf_idx on public.srs_state(user_id, pdf_id);
create index srs_state_next_review_idx on public.srs_state(user_id, next_review);

-- ─── Reviews (append-only log) ───────────────────────────────────────────────

create table public.reviews (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references public.users(id) on delete cascade,
  question_id     uuid not null references public.questions(id) on delete cascade,
  pdf_id          uuid not null references public.pdfs(id) on delete cascade,
  quality         integer not null check (quality between 1 and 4),
  interval_after  numeric(10,4) not null,
  ease_after      numeric(5,4)  not null,
  reviewed_at     timestamptz   not null default now()
);

alter table public.reviews enable row level security;

create policy "reviews: own rows" on public.reviews
  for all using (auth.uid() = user_id);

create index reviews_user_pdf_idx on public.reviews(user_id, pdf_id);

-- ─── Flagged Questions ────────────────────────────────────────────────────────

create table public.flagged_questions (
  id          uuid primary key default uuid_generate_v4(),
  pdf_id      uuid not null references public.pdfs(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  question_id uuid references public.questions(id) on delete set null,
  reason      text not null,
  raw_json    jsonb,
  created_at  timestamptz not null default now()
);

alter table public.flagged_questions enable row level security;

create policy "flagged_questions: own rows" on public.flagged_questions
  for all using (auth.uid() = user_id);

-- ─── Highlights ──────────────────────────────────────────────────────────────

create table public.highlights (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.users(id) on delete cascade,
  pdf_id      uuid not null references public.pdfs(id) on delete cascade,
  chunk_id    text references public.chunks(id) on delete cascade,
  start_off   integer not null,
  end_off     integer not null,
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.highlights enable row level security;

create policy "highlights: own rows" on public.highlights
  for all using (auth.uid() = user_id);

-- ─── match_chunks RPC ────────────────────────────────────────────────────────

create or replace function match_chunks(
  query_embedding vector(512),
  pdf_id_filter   uuid,
  match_count     int default 8
)
returns table (
  id          text,
  text        text,
  start_page  int,
  end_page    int,
  headers     text[],
  similarity  float
)
language sql stable as $$
  select
    c.id,
    c.text,
    c.start_page,
    c.end_page,
    c.headers,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where c.pdf_id = pdf_id_filter
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
