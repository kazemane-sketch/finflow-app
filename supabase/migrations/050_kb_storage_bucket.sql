-- ================================================================
-- Migration 050: Storage bucket for KB normative documents (PDFs)
-- ================================================================

-- Bucket for KB documents (normative PDFs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kb-documents',
  'kb-documents',
  false,
  52428800,  -- 50MB max
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Policy: platform admins can manage files
CREATE POLICY "kb_docs_storage_admin_all" ON storage.objects
  FOR ALL USING (
    bucket_id = 'kb-documents'
    AND (SELECT public.is_platform_admin())
  )
  WITH CHECK (
    bucket_id = 'kb-documents'
    AND (SELECT public.is_platform_admin())
  );
