create table public.pdf_jobs (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.users(id) on delete cascade,
  pdf_id           uuid not null references public.pdfs(id) on delete cascade,
  pdf_name         text not null,
  page_count       integer,
  question_count   integer,
  concept_count    integer,
  density          text not null
                    check (density in ('standard','comprehensive','boards')),
  plan_name        text not null default 'free',
  status           text not null
                    check (status in ('processing','completed','failed')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  openai_cost_usd  numeric(12,6) not null default 0,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.pdf_jobs enable row level security;

create policy "pdf_jobs: own rows" on public.pdf_jobs
  for all using (auth.uid() = user_id);

create index pdf_jobs_user_id_idx on public.pdf_jobs(user_id);
create index pdf_jobs_pdf_id_idx on public.pdf_jobs(pdf_id);
create index pdf_jobs_status_idx on public.pdf_jobs(status);
create index pdf_jobs_plan_name_idx on public.pdf_jobs(plan_name);
create index pdf_jobs_started_at_idx on public.pdf_jobs(started_at desc);

create or replace function public.set_pdf_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_pdf_jobs_updated_at
  before update on public.pdf_jobs
  for each row execute procedure public.set_pdf_jobs_updated_at();
