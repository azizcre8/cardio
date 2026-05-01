import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { normalizeSharedBankSlug } from '@/lib/join-intent';
import { addSharedBankMember, getSharedBankBySlug } from '@/lib/storage';
import { supabaseAdmin } from '@/lib/supabase';
import { getSharedBankSources } from '@/lib/shared-banks';
import type { SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const slug = normalizeSharedBankSlug(params.slug);
  if (!slug) return jsonNotFound('Shared bank not found');

  const bank = await getSharedBankBySlug(slug);
  if (!bank || !bank.is_active) return jsonNotFound('Shared bank not found');

  if (bank.owner_user_id !== auth.userId) {
    try {
      await addSharedBankMember(bank.id, auth.userId, 'member');
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Failed to join');
    }
  }

  const [bankWithSources, { data: membership }] = await Promise.all([
    getSharedBankSources(supabaseAdmin, bank),
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
      ...bankWithSources,
      membership_role: bank.owner_user_id === auth.userId
        ? 'owner'
        : (membership?.role as SharedBank['membership_role']) ?? 'member',
      membership_joined_at: membership?.joined_at ?? null,
    },
  });
}
