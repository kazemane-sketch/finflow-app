-- =============================================
-- COMPANY MEMORY + ENTITY EMBEDDINGS
-- Pillar 1 of Commercialista Brain architecture:
-- 1. company_memory: unified fact store for all company-specific knowledge
-- 2. Embedding columns on chart_of_accounts, categories, articles, projects
-- 3. pgvector search functions for embedding pre-flight
-- =============================================

-- ─── company_memory table ───────────────────────────
CREATE TABLE IF NOT EXISTS public.company_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fact_type text NOT NULL CHECK (fact_type IN (
    'counterparty_pattern',    -- "Fornitore X sempre classificato su conto Y"
    'account_mapping',         -- "Carburanti 100% = camion/escavatori, 20% = auto"
    'user_correction',         -- "Utente ha corretto da X a Y"
    'fiscal_rule',             -- "Azienda settore cave, ATECO 089909"
    'general'                  -- catch-all per regole generiche
  )),
  fact_text text NOT NULL,               -- testo descrittivo del fatto (human-readable)
  embedding halfvec(3072),               -- Gemini embedding-001 per ricerca semantica
  metadata jsonb DEFAULT '{}',           -- dati strutturati (account_code, deducibilita_pct, etc.)
  counterparty_id uuid REFERENCES public.counterparties(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'system' CHECK (source IN (
    'system',              -- auto-generato da migrazione dati
    'user_confirm',        -- generato da conferma classificazione
    'user_correction',     -- generato da correzione suggerimento AI
    'reconciliation',      -- generato da conferma riconciliazione
    'ai_chat',             -- generato da interazione AI Chat
    'manual'               -- inserito manualmente dall'utente
  )),
  usage_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_memory_select ON public.company_memory FOR SELECT
  USING (is_company_member(company_id));
CREATE POLICY company_memory_insert ON public.company_memory FOR INSERT
  WITH CHECK (is_company_member(company_id));
CREATE POLICY company_memory_update ON public.company_memory FOR UPDATE
  USING (is_company_member(company_id));
CREATE POLICY company_memory_delete ON public.company_memory FOR DELETE
  USING (is_company_member(company_id));

-- ─── indexes for company_memory ─────────────────────
CREATE INDEX IF NOT EXISTS idx_company_memory_type
  ON public.company_memory(company_id, fact_type)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_company_memory_counterparty
  ON public.company_memory(company_id, counterparty_id)
  WHERE counterparty_id IS NOT NULL AND active = true;

-- Deduplication: prevent exact duplicate facts
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_memory_dedup
  ON public.company_memory(company_id, fact_type, md5(fact_text))
  WHERE active = true;

-- HNSW vector index for cosine similarity
DO $$
BEGIN
  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_company_memory_embedding_hnsw
      ON public.company_memory
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL AND active = true
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping company_memory HNSW index: %'', SQLERRM;
  END;
END $$;

-- ─── search function for company_memory ─────────────
CREATE OR REPLACE FUNCTION public.search_company_memory(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_fact_types text[] DEFAULT NULL,
  p_counterparty_id uuid DEFAULT NULL,
  p_limit int DEFAULT 20
)
RETURNS TABLE(
  id uuid,
  fact_type text,
  fact_text text,
  metadata jsonb,
  counterparty_id uuid,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT cm.id, cm.fact_type, cm.fact_text, cm.metadata, cm.counterparty_id,
         (1 - (cm.embedding <=> p_query_embedding))::float AS similarity
  FROM public.company_memory cm
  WHERE cm.company_id = p_company_id
    AND cm.active = true
    AND cm.embedding IS NOT NULL
    AND (p_fact_types IS NULL OR cm.fact_type = ANY(p_fact_types))
    AND (p_counterparty_id IS NULL OR cm.counterparty_id IS NULL OR cm.counterparty_id = p_counterparty_id)
  ORDER BY cm.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 20), 50)
$$;

-- =============================================
-- EMBEDDING COLUMNS ON ENTITIES
-- Pre-computed Gemini embeddings for semantic search
-- during classification pre-flight
-- =============================================

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS embedding halfvec(3072);

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS embedding halfvec(3072);

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS embedding halfvec(3072);

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS embedding halfvec(3072);

-- ─── HNSW indexes for entity embeddings ─────────────
DO $$
BEGIN
  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_coa_embedding_hnsw
      ON public.chart_of_accounts
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping chart_of_accounts HNSW index: %'', SQLERRM;
  END;

  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_categories_embedding_hnsw
      ON public.categories
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping categories HNSW index: %'', SQLERRM;
  END;

  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_projects_embedding_hnsw
      ON public.projects
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping projects HNSW index: %'', SQLERRM;
  END;

  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_articles_embedding_hnsw
      ON public.articles
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping articles HNSW index: %'', SQLERRM;
  END;
END $$;

-- ─── Search functions for entity pre-flight ─────────

-- Accounts: direction-filtered via p_sections
CREATE OR REPLACE FUNCTION public.search_accounts_by_embedding(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_sections text[] DEFAULT NULL,
  p_limit int DEFAULT 15
)
RETURNS TABLE(id uuid, code text, name text, section text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT a.id, a.code, a.name, a.section,
         (1 - (a.embedding <=> p_query_embedding))::float AS similarity
  FROM public.chart_of_accounts a
  WHERE a.company_id = p_company_id
    AND a.active = true
    AND a.is_header = false
    AND a.embedding IS NOT NULL
    AND (p_sections IS NULL OR a.section = ANY(p_sections))
  ORDER BY a.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 15), 30)
$$;

-- Categories: direction-filtered via p_types
CREATE OR REPLACE FUNCTION public.search_categories_by_embedding(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_types text[] DEFAULT NULL,
  p_limit int DEFAULT 10
)
RETURNS TABLE(id uuid, name text, type text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT c.id, c.name, c.type,
         (1 - (c.embedding <=> p_query_embedding))::float AS similarity
  FROM public.categories c
  WHERE c.company_id = p_company_id
    AND c.active = true
    AND c.embedding IS NOT NULL
    AND (p_types IS NULL OR c.type = ANY(p_types))
  ORDER BY c.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 10), 20)
$$;

-- Articles
CREATE OR REPLACE FUNCTION public.search_articles_by_embedding(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_limit int DEFAULT 10
)
RETURNS TABLE(id uuid, code text, name text, keywords text[], similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT a.id, a.code, a.name, a.keywords,
         (1 - (a.embedding <=> p_query_embedding))::float AS similarity
  FROM public.articles a
  WHERE a.company_id = p_company_id
    AND a.active = true
    AND a.embedding IS NOT NULL
  ORDER BY a.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 10), 20)
$$;

-- Projects (CdC)
CREATE OR REPLACE FUNCTION public.search_projects_by_embedding(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_limit int DEFAULT 8
)
RETURNS TABLE(id uuid, code text, name text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT p.id, p.code, p.name,
         (1 - (p.embedding <=> p_query_embedding))::float AS similarity
  FROM public.projects p
  WHERE p.company_id = p_company_id
    AND p.status = 'active'
    AND p.embedding IS NOT NULL
  ORDER BY p.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 8), 20)
$$;

-- ─── GRANTS ─────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.search_company_memory(halfvec(3072), uuid, text[], uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_memory(halfvec(3072), uuid, text[], uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_accounts_by_embedding(halfvec(3072), uuid, text[], int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_accounts_by_embedding(halfvec(3072), uuid, text[], int) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_categories_by_embedding(halfvec(3072), uuid, text[], int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_categories_by_embedding(halfvec(3072), uuid, text[], int) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_articles_by_embedding(halfvec(3072), uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_articles_by_embedding(halfvec(3072), uuid, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_projects_by_embedding(halfvec(3072), uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_projects_by_embedding(halfvec(3072), uuid, int) TO service_role;
