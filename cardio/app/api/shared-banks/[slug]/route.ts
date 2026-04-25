import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import type { Deck, PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: bankRow } = await auth.supabase
    .from('shared_banks')
    .select('*')
    .eq('slug', params.slug)
    .eq('is_active', true)
    .single();

  if (!bankRow) return jsonNotFound('Shared bank not found');

  const bank = bankRow as SharedBank;

  const [{ data: sourcePdf }, { data: sourceDeck }, { data: sourcePdfs }, { data: membership }] = await Promise.all([
    bank.source_pdf_id
      ? auth.supabase.from('pdfs').select('*').eq('id', bank.source_pdf_id).maybeSingle()
      : Promise.resolve({ data: null }),
    bank.source_deck_id
      ? auth.supabase.from('decks').select('*').eq('id', bank.source_deck_id).maybeSingle()
      : Promise.resolve({ data: null }),
    bank.source_deck_id
      ? auth.supabase.from('pdfs').select('*').eq('deck_id', bank.source_deck_id).order('position', { ascending: true }).order('name', { ascending: true })
      : Promise.resolve({ data: [] }),
    auth.supabase
      .from('shared_bank_members')
      .select('role, joined_at')
      .eq('shared_bank_id', bank.id)
      .eq('user_id', auth.userId)
      .maybeSingle(),
  ]);

  return jsonOk({
    bank: {
      ...bank,
      source_pdf: (sourcePdf as PDF | null) ?? null,
      source_deck: (sourceDeck as Deck | null) ?? null,
      source_pdfs: (sourcePdfs ?? []) as PDF[],
      membership_role: (membership?.role as SharedBank['membership_role']) ?? null,
      membership_joined_at: membership?.joined_at ?? null,
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: bankRow, error: bankError } = await auth.supabase
    .from('shared_banks')
    .select('id, owner_user_id')
    .eq('slug', params.slug)
    .single();

  if (bankError || !bankRow) return jsonNotFound('Shared bank not found');

  if ((bankRow as SharedBank).owner_user_id !== auth.userId) {
    return jsonError('Only the owner can revoke a shared bank', 403);
  }

  const { error: updateError } = await auth.supabase
    .from('shared_banks')
    .update({ is_active: false })
    .eq('id', (bankRow as SharedBank).id);

  if (updateError) return jsonError(updateError.message);

  return jsonOk({ revoked: true, slug: params.slug });
}
