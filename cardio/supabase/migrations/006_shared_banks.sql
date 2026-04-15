-- ─── Shared Banks ────────────────────────────────────────────────────────────
-- Adds a publish/access layer on top of the existing user-owned PDF pipeline.
-- Content remains canonical on the source PDF, while learners get their own
-- SRS and review data through the existing user-scoped tables.

create table public.shared_banks (
  id              uuid primary key default uuid_generate_v4(),
  owner_user_id   uuid not null references public.users(id) on delete cascade,
  source_pdf_id   uuid not null references public.pdfs(id) on delete cascade,
  title           text not null,
  description     text,
  slug            text not null unique,
  visibility      text not null default 'private'
                    check (visibility in ('private', 'invite_only', 'public')),
  is_active       boolean not null default true,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (owner_user_id, source_pdf_id)
);

alter table public.shared_banks enable row level security;

create policy "shared_banks: owners manage" on public.shared_banks
  for all using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index shared_banks_owner_user_id_idx on public.shared_banks(owner_user_id);
create index shared_banks_source_pdf_id_idx on public.shared_banks(source_pdf_id);
create index shared_banks_slug_idx on public.shared_banks(slug);

create table public.shared_bank_members (
  id              uuid primary key default uuid_generate_v4(),
  shared_bank_id  uuid not null references public.shared_banks(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null default 'member'
                    check (role in ('owner', 'member')),
  joined_at       timestamptz not null default now(),

  unique (shared_bank_id, user_id)
);

alter table public.shared_bank_members enable row level security;

create policy "shared_bank_members: users can view own memberships" on public.shared_bank_members
  for select using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.shared_banks b
      where b.id = shared_bank_id
        and b.owner_user_id = auth.uid()
    )
  );

create policy "shared_bank_members: owners manage memberships" on public.shared_bank_members
  for all using (
    exists (
      select 1
      from public.shared_banks b
      where b.id = shared_bank_id
        and b.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.shared_banks b
      where b.id = shared_bank_id
        and b.owner_user_id = auth.uid()
    )
  );

create index shared_bank_members_shared_bank_id_idx on public.shared_bank_members(shared_bank_id);
create index shared_bank_members_user_id_idx on public.shared_bank_members(user_id);

create policy "shared_banks: visible to members and public" on public.shared_banks
  for select using (
    is_active = true
    and (
      auth.uid() = owner_user_id
      or visibility = 'public'
      or exists (
        select 1
        from public.shared_bank_members m
        where m.shared_bank_id = id
          and m.user_id = auth.uid()
      )
    )
  );

create or replace function public.set_shared_banks_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_shared_banks_updated_at
  before update on public.shared_banks
  for each row execute procedure public.set_shared_banks_updated_at();

create or replace function public.create_shared_bank_owner_membership()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.shared_bank_members (shared_bank_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner')
  on conflict (shared_bank_id, user_id) do update set role = 'owner';
  return new;
end;
$$;

create trigger create_shared_bank_owner_membership
  after insert on public.shared_banks
  for each row execute procedure public.create_shared_bank_owner_membership();

create or replace function public.user_can_access_shared_pdf(p_pdf_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1
    from public.shared_banks b
    left join public.shared_bank_members m
      on m.shared_bank_id = b.id
     and m.user_id = p_user_id
    where b.source_pdf_id = p_pdf_id
      and b.is_active = true
      and (
        b.owner_user_id = p_user_id
        or b.visibility = 'public'
        or m.user_id is not null
      )
  );
$$;

create policy "pdfs: shared bank read access" on public.pdfs
  for select using (public.user_can_access_shared_pdf(id, auth.uid()));

create policy "chunks: shared bank read access" on public.chunks
  for select using (public.user_can_access_shared_pdf(pdf_id, auth.uid()));

create policy "concepts: shared bank read access" on public.concepts
  for select using (public.user_can_access_shared_pdf(pdf_id, auth.uid()));

create policy "questions: shared bank read access" on public.questions
  for select using (public.user_can_access_shared_pdf(pdf_id, auth.uid()));
