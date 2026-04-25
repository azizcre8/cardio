import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { addSharedBankMember, getSharedBankBySlug } from '@/lib/storage';
import { supabaseAdmin } from '@/lib/supabase';
import type { PDF, SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const bank = await getSharedBankBySlug(params.slug);
  if (!bank || !bank.is_active) return jsonNotFound('Shared bank not found');

  if (bank.owner_user_id !== auth.userId) {
    try {
      await addSharedBankMember(bank.id, auth.userId, 'member');
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Failed to join');
    }
  }

  const [{ data: sourcePdf }, { data: membership }] = await Promise.all([
    supabaseAdmin.from('pdfs').select('*').eq('id', bank.source_pdf_id).maybeSingle(),
    supabaseAdmin
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
