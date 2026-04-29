-- Make deck-level shared banks include PDFs in descendant subdecks.

CREATE OR REPLACE FUNCTION public.shared_bank_deck_contains_pdf(
  p_source_deck_id uuid,
  p_pdf_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE descendant_decks AS (
    SELECT d.id
    FROM public.decks d
    WHERE d.id = p_source_deck_id

    UNION ALL

    SELECT child.id
    FROM public.decks child
    JOIN descendant_decks parent ON child.parent_id = parent.id
  )
  SELECT EXISTS (
    SELECT 1
    FROM public.pdfs pdf
    JOIN descendant_decks deck ON deck.id = pdf.deck_id
    WHERE pdf.id = p_pdf_id
  );
$$;

CREATE OR REPLACE FUNCTION public.user_can_access_shared_pdf(p_pdf_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- Direct PDF share
    SELECT 1
    FROM public.shared_banks b
    LEFT JOIN public.shared_bank_members m
      ON m.shared_bank_id = b.id AND m.user_id = p_user_id
    WHERE b.source_pdf_id = p_pdf_id
      AND b.is_active = true
      AND (
        b.owner_user_id = p_user_id
        OR b.visibility = 'public'
        OR m.user_id IS NOT NULL
      )
  )
  OR EXISTS (
    -- Deck share: the PDF may be in the shared deck or any subdeck below it.
    SELECT 1
    FROM public.shared_banks b
    LEFT JOIN public.shared_bank_members m
      ON m.shared_bank_id = b.id AND m.user_id = p_user_id
    WHERE b.source_deck_id IS NOT NULL
      AND b.is_active = true
      AND public.shared_bank_deck_contains_pdf(b.source_deck_id, p_pdf_id)
      AND (
        b.owner_user_id = p_user_id
        OR b.visibility = 'public'
        OR m.user_id IS NOT NULL
      )
  );
$$;
