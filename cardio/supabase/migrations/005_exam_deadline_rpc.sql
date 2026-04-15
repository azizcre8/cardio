-- ─── get_exam_deadline_for_pdf ───────────────────────────────────────────────
-- Walks up the deck ancestry of a PDF and returns the due_date of the nearest
-- ancestor (or self) that is marked as an exam block.
-- Falls back to NULL if the PDF has no deck or no exam-block ancestor.
-- The queue route uses this to tighten the SRS interval for each PDF.

create or replace function public.get_exam_deadline_for_pdf(p_pdf_id uuid)
returns timestamptz language sql stable security definer as $$
  with recursive ancestors as (
    -- Base: the deck this PDF directly belongs to
    select d.id, d.parent_id, d.is_exam_block, d.due_date, 0 as depth
    from   public.decks d
    join   public.pdfs  p on p.deck_id = d.id
    where  p.id = p_pdf_id

    union all

    -- Walk upward one level at a time
    select d.id, d.parent_id, d.is_exam_block, d.due_date, a.depth + 1
    from   public.decks   d
    join   ancestors       a on d.id = a.parent_id
  )
  select due_date
  from   ancestors
  where  is_exam_block = true
    and  due_date is not null
  order  by depth asc
  limit  1;
$$;
