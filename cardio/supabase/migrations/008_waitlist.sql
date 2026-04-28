create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  email text not null,
  use_case text not null,
  created_at timestamptz not null default now()
);

create index if not exists waitlist_user_id_idx on public.waitlist(user_id);
create index if not exists waitlist_created_at_idx on public.waitlist(created_at desc);

alter table public.waitlist enable row level security;

create policy "users can manage their own waitlist entries"
  on public.waitlist for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
