import { supabaseBrowser } from '@/lib/supabase-browser';

export async function uploadPdfToStorage(file: File, userId: string): Promise<string> {
  const path = `${userId}/${Date.now()}-${file.name}`;
  const { error } = await supabaseBrowser.storage.from('pdfs').upload(path, file, {
    contentType: 'application/pdf',
    upsert: false,
  });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  return path;
}
