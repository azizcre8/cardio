import { supabaseAdmin } from '@/lib/supabase';

export function slugifySharedBank(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'bank';
}

export async function createUniqueSharedBankSlug(baseInput: string) {
  const base = slugifySharedBank(baseInput);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await supabaseAdmin
      .from('shared_banks')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (error) {
      throw new Error(`createUniqueSharedBankSlug: ${error.message}`);
    }

    if (!data) return slug;
  }

  return `${base}-${Date.now().toString(36)}`;
}
