-- ─── Deck Hierarchy ──────────────────────────────────────────────────────────
-- Adds a self-referencing `decks` table for Anki-style folder/subdeck nesting,
-- exam block support with hard deadlines, and extends `pdfs` with deck membership.

-- ─── decks ────────────────────────────────────────────────────────────────────

create table public.decks (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references public.users(id) on delete cascade,
  parent_id     uuid references public.decks(id) on delete set null,
  name          text not null,
  is_exam_block boolean not null default false,
  due_date      timestamptz,
  position      integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.decks enable row level security;

create policy "decks: own rows" on public.decks
  for all using (auth.uid() = user_id);

create index decks_user_id_idx  on public.decks(user_id);
create index decks_parent_id_idx on public.decks(parent_id);

-- ─── Extend pdfs ──────────────────────────────────────────────────────────────

alter table public.pdfs
  add column if not exists deck_id      uuid references public.decks(id) on delete set null,
  add column if not exists display_name text,
  add column if not exists position     integer not null default 0;

create index if not exists pdfs_deck_id_idx on public.pdfs(deck_id);

-- ─── Recursive tree helper ────────────────────────────────────────────────────
-- Returns all decks for a user ordered by hierarchy depth, then position, then name.
-- Used by GET /api/decks to fetch the full tree in one query.

create or replace function public.get_deck_tree(p_user_id uuid)
returns table (
  id            uuid,
  user_id       uuid,
  parent_id     uuid,
  name          text,
  is_exam_block boolean,
  due_date      timestamptz,
  position      integer,
  created_at    timestamptz,
  updated_at    timestamptz,
  depth         integer
)
language sql stable security definer as $$
  with recursive deck_tree as (
    -- Base case: root-level decks (no parent)
    select d.id, d.user_id, d.parent_id, d.name,
           d.is_exam_block, d.due_date, d.position,
           d.created_at, d.updated_at,
           0 as depth
    from public.decks d
    where d.user_id = p_user_id
      and d.parent_id is null

    union all

    -- Recursive case: children of already-found nodes
    select d.id, d.user_id, d.parent_id, d.name,
           d.is_exam_block, d.due_date, d.position,
           d.created_at, d.updated_at,
           dt.depth + 1
    from public.decks d
    join deck_tree dt on d.parent_id = dt.id
  )
  select * from deck_tree
  order by depth, position, name;
$$;
