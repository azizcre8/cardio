import { requireUser } from '@/lib/auth';
import { jsonError, jsonNotFound, jsonOk } from '@/lib/api';
import { normalizeSharedBankSlug } from '@/lib/join-intent';
import { getSharedBankSources } from '@/lib/shared-banks';
import { supabaseAdmin } from '@/lib/supabase';
import type { SharedBank } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const slug = normalizeSharedBankSlug(params.slug);
  if (!slug) return jsonNotFound('Shared bank not found');

  const { data: bankRow } = await auth.supabase
    .from('shared_banks')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (!bankRow) return jsonNotFound('Shared bank not found');

  const bank = bankRow as SharedBank;

  const [bankWithSources, { data: membership }] = await Promise.all([
    getSharedBankSources(supabaseAdmin, bank),
    auth.supabase
      .from('shared_bank_members')
      .select('role, joined_at')
      .eq('shared_bank_id', bank.id)
      .eq('user_id', auth.userId)
      .maybeSingle(),
  ]);

  return jsonOk({
    bank: {
      ...bankWithSources,
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

  const slug = normalizeSharedBankSlug(params.slug);
  if (!slug) return jsonNotFound('Shared bank not found');

  const { data: bankRow, error: bankError } = await auth.supabase
    .from('shared_banks')
    .select('id, owner_user_id')
    .eq('slug', slug)
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

  return jsonOk({ revoked: true, slug });
}
