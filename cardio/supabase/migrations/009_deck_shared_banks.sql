-- Make source_pdf_id nullable
ALTER TABLE public.shared_banks ALTER COLUMN source_pdf_id DROP NOT NULL;

-- Add source_deck_id
ALTER TABLE public.shared_banks ADD COLUMN source_deck_id uuid REFERENCES public.decks(id) ON DELETE CASCADE;

-- Exactly one source must be set
ALTER TABLE public.shared_banks ADD CONSTRAINT shared_banks_one_source CHECK (
  (source_pdf_id IS NOT NULL AND source_deck_id IS NULL) OR
  (source_pdf_id IS NULL AND source_deck_id IS NOT NULL)
);

-- Drop old unique constraint (it does not work well with nullable)
ALTER TABLE public.shared_banks DROP CONSTRAINT shared_banks_owner_user_id_source_pdf_id_key;

-- Replace with partial unique indexes
CREATE UNIQUE INDEX unique_shared_bank_per_pdf ON public.shared_banks(owner_user_id, source_pdf_id) WHERE source_pdf_id IS NOT NULL;
CREATE UNIQUE INDEX unique_shared_bank_per_deck ON public.shared_banks(owner_user_id, source_deck_id) WHERE source_deck_id IS NOT NULL;

-- Index on source_deck_id
CREATE INDEX shared_banks_source_deck_id_idx ON public.shared_banks(source_deck_id);

-- Update user_can_access_shared_pdf to also check deck-based shares
CREATE OR REPLACE FUNCTION public.user_can_access_shared_pdf(p_pdf_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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
    -- Deck-based share: PDF belongs to a shared deck the user can access
    SELECT 1
    FROM public.pdfs pdf
    JOIN public.shared_banks b ON b.source_deck_id = pdf.deck_id
    LEFT JOIN public.shared_bank_members m
      ON m.shared_bank_id = b.id AND m.user_id = p_user_id
    WHERE pdf.id = p_pdf_id
      AND b.is_active = true
      AND (
        b.owner_user_id = p_user_id
        OR b.visibility = 'public'
        OR m.user_id IS NOT NULL
      )
  );
$$;
