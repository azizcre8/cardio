-- Add question concept label for direct reads and fix recursive shared-bank RLS.

alter table public.questions
  add column if not exists concept_name text;

create or replace function public.is_shared_bank_owner(p_shared_bank_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shared_banks b
    where b.id = p_shared_bank_id
      and b.owner_user_id = p_user_id
  );
$$;

create or replace function public.is_shared_bank_member(p_shared_bank_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shared_bank_members m
    where m.shared_bank_id = p_shared_bank_id
      and m.user_id = p_user_id
  );
$$;

drop policy if exists "shared_bank_members: users can view own memberships" on public.shared_bank_members;
create policy "shared_bank_members: users can view own memberships" on public.shared_bank_members
  for select using (
    auth.uid() = user_id
    or public.is_shared_bank_owner(shared_bank_id, auth.uid())
  );

drop policy if exists "shared_bank_members: owners manage memberships" on public.shared_bank_members;
create policy "shared_bank_members: owners manage memberships" on public.shared_bank_members
  for all using (
    public.is_shared_bank_owner(shared_bank_id, auth.uid())
  )
  with check (
    public.is_shared_bank_owner(shared_bank_id, auth.uid())
  );

drop policy if exists "shared_banks: visible to members and public" on public.shared_banks;
create policy "shared_banks: visible to members and public" on public.shared_banks
  for select using (
    is_active = true
    and (
      auth.uid() = owner_user_id
      or visibility = 'public'
      or public.is_shared_bank_member(id, auth.uid())
    )
  );
