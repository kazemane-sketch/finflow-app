-- =============================================
-- KNOWLEDGE BASE - documenti + chunks con embeddings
-- =============================================

-- ─── kb_documents: metadati documento ────────
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_type text NOT NULL,                           -- 'pdf', 'txt', 'csv'
  file_size bigint NOT NULL DEFAULT 0,
  storage_path text,                                 -- path in Supabase Storage
  status text NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  chunk_count int NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY kb_documents_select ON public.kb_documents FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.company_members cm
                 WHERE cm.company_id = kb_documents.company_id AND cm.user_id = auth.uid()));
CREATE POLICY kb_documents_insert ON public.kb_documents FOR INSERT
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.company_members cm
              WHERE cm.company_id = kb_documents.company_id AND cm.user_id = auth.uid()));
CREATE POLICY kb_documents_update ON public.kb_documents FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY kb_documents_delete ON public.kb_documents FOR DELETE
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_kb_documents_company
  ON public.kb_documents(company_id, status, created_at DESC);

-- ─── kb_chunks: porzioni di testo con embedding ────
CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content text NOT NULL,
  token_count int NOT NULL DEFAULT 0,
  embedding vector(3072),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY kb_chunks_select ON public.kb_chunks FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.company_members cm
                 WHERE cm.company_id = kb_chunks.company_id AND cm.user_id = auth.uid()));

-- Service role needs full access for edge function processing
CREATE POLICY kb_chunks_service ON public.kb_chunks FOR ALL
  USING (true)
  WITH CHECK (true);

-- HNSW index for cosine similarity (halfvec per performance, same as bank embeddings)
DO $$
BEGIN
  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_cosine_hnsw
      ON public.kb_chunks
      USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'Skipping KB ANN vector index creation: %', SQLERRM;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_chunks_document
  ON public.kb_chunks(document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_company
  ON public.kb_chunks(company_id);

-- ─── Storage bucket per i file originali ────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'kb-documents',
  'kb-documents',
  false,
  20971520,  -- 20 MB
  ARRAY['application/pdf', 'text/plain', 'text/csv']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: users can upload to their company path
CREATE POLICY kb_storage_insert ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'kb-documents'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY kb_storage_select ON storage.objects FOR SELECT
  USING (
    bucket_id = 'kb-documents'
    AND auth.uid() IS NOT NULL
  );

CREATE POLICY kb_storage_delete ON storage.objects FOR DELETE
  USING (
    bucket_id = 'kb-documents'
    AND auth.uid() IS NOT NULL
  );

-- ─── search function per kb_chunks ────
CREATE OR REPLACE FUNCTION public.kb_search_chunks(
  p_company_id uuid,
  p_query_vector vector(3072),
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  file_name text,
  similarity numeric
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 10), 50));
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.chunk_index,
    kc.content,
    kd.file_name,
    (1 - (kc.embedding <=> p_query_vector))::numeric AS similarity
  FROM public.kb_chunks kc
  JOIN public.kb_documents kd ON kd.id = kc.document_id
  WHERE kc.company_id = p_company_id
    AND kc.embedding IS NOT NULL
    AND kd.status = 'ready'
  ORDER BY kc.embedding <=> p_query_vector
  LIMIT v_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kb_search_chunks(uuid, vector(3072), int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kb_search_chunks(uuid, vector(3072), int) TO service_role;
