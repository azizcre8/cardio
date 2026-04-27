-- Create private bucket for user PDF uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pdfs', 'pdfs', false, 52428800, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Users can upload own PDFs"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can read own PDFs"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own PDFs"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'pdfs' AND (storage.foldername(name))[1] = auth.uid()::text);
