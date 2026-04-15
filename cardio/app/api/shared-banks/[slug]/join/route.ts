import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import type { PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { data: bankRow, error: bankError } = await auth.supabase
    .from('shared_banks')
    .select('*')
    .eq('slug', params.slug)
    .eq('is_active', true)
    .single();

  if (bankError || !bankRow) return jsonNotFound('Shared bank not found');

  const bank = bankRow as SharedBank;

  if (bank.owner_user_id !== auth.userId) {
    const { error: joinError } = await auth.supabase
      .from('shared_bank_members')
      .upsert(
        {
          shared_bank_id: bank.id,
          user_id: auth.userId,
          role: 'member',
        },
        { onConflict: 'shared_bank_id,user_id' },
      );

    if (joinError) return jsonError(joinError.message);
  }

  const [{ data: sourcePdf }, { data: membership }] = await Promise.all([
    auth.supabase.from('pdfs').select('*').eq('id', bank.source_pdf_id).maybeSingle(),
    auth.supabase
      .from('shared_bank_members')
      .select('role, joined_at')
      .eq('shared_bank_id', bank.id)
      .eq('user_id', auth.userId)
      .maybeSingle(),
  ]);

  return jsonOk({
    joined: true,
    bank: {
      ...bank,
      source_pdf: (sourcePdf as PDF | null) ?? null,
      membership_role: bank.owner_user_id === auth.userId
        ? 'owner'
        : (membership?.role as SharedBank['membership_role']) ?? 'member',
      membership_joined_at: membership?.joined_at ?? null,
    },
  });
}
