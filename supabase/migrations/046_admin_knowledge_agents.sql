-- 046_admin_knowledge_agents.sql
-- Admin Panel: Knowledge Base + Documenti + Agent Config + Rules
-- Platform-level tables gestite dall'admin della piattaforma

-- ============================================================
-- 1. ATECO e settore su companies (MANCANTE, critico per fiscalità)
-- ============================================================
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS ateco_code text,
  ADD COLUMN IF NOT EXISTS ateco_description text,
  ADD COLUMN IF NOT EXISTS business_sector text;

COMMENT ON COLUMN public.companies.ateco_code IS 'Codice ATECO 2007 azienda (es. 08.11.00)';
COMMENT ON COLUMN public.companies.ateco_description IS 'Descrizione attività ATECO';
COMMENT ON COLUMN public.companies.business_sector IS 'Macro-settore (estrazione_cave, costruzioni, trasporti, commercio, ristorazione, servizi_professionali, manifattura, altro)';

-- Aggiorna CAVECO subito
UPDATE public.companies
SET ateco_code = '08.11.00',
    ateco_description = 'Estrazione di pietra, sabbia e argilla',
    business_sector = 'estrazione_cave'
WHERE vat_number LIKE '%07951511000%' OR name ILIKE '%caveco%';

-- ============================================================
-- 2. PLATFORM ADMINS
-- ============================================================
-- Per trovare il tuo user_id: SELECT id, email FROM auth.users;
-- Poi: INSERT INTO platform_admins (user_id) VALUES ('il-tuo-user-id');
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'platform_admins_self' AND tablename = 'platform_admins') THEN
    CREATE POLICY "platform_admins_self" ON public.platform_admins
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- Helper: check if current user is platform admin
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()
  );
$$;

-- ============================================================
-- 3. KNOWLEDGE BASE — regole strutturate (manuale operativo)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Organizzazione
  domain text NOT NULL CHECK (domain IN (
    'iva', 'ires_irap', 'ritenute', 'classificazione',
    'settoriale', 'operativo', 'aggiornamenti'
  )),
  audience text NOT NULL DEFAULT 'both' CHECK (audience IN (
    'commercialista', 'revisore', 'both'
  )),

  -- Contenuto
  title text NOT NULL,
  content text NOT NULL,
  normativa_ref text[] DEFAULT '{}',
  fiscal_values jsonb DEFAULT '{}',

  -- Trigger conditions
  trigger_conditions jsonb DEFAULT '{}',
  trigger_ateco_prefixes text[] DEFAULT '{}',
  trigger_counterparty_types text[] DEFAULT '{}',
  trigger_account_prefixes text[] DEFAULT '{}',
  trigger_vat_natures text[] DEFAULT '{}',
  trigger_doc_types text[] DEFAULT '{}',
  trigger_keywords text[] DEFAULT '{}',

  -- Validità temporale
  effective_from date DEFAULT '2000-01-01',
  effective_to date DEFAULT '2099-12-31',

  -- Scope ATECO azienda (NULL = tutti i settori)
  ateco_scope text[],

  -- Stato e ordinamento
  priority int NOT NULL DEFAULT 50,
  sort_order int DEFAULT 0,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved', 'rejected', 'superseded')),
  active boolean NOT NULL DEFAULT true,

  -- Provenienza (da documento o manuale)
  source_document_id uuid,
  extraction_confidence numeric(5,2),

  -- Embedding per RAG
  embedding halfvec(3072),

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_admin_all' AND tablename = 'knowledge_base') THEN
    CREATE POLICY "kb_admin_all" ON public.knowledge_base
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_read_authenticated' AND tablename = 'knowledge_base') THEN
    CREATE POLICY "kb_read_authenticated" ON public.knowledge_base
      FOR SELECT USING (auth.uid() IS NOT NULL AND active = true AND status = 'approved');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_domain ON public.knowledge_base(domain) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_audience ON public.knowledge_base(audience) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_status ON public.knowledge_base(status);
CREATE INDEX IF NOT EXISTS idx_kb_ateco_scope ON public.knowledge_base USING gin(ateco_scope) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_trigger_ateco ON public.knowledge_base USING gin(trigger_ateco_prefixes) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_trigger_vat ON public.knowledge_base USING gin(trigger_vat_natures) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_trigger_doc ON public.knowledge_base USING gin(trigger_doc_types) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_trigger_kw ON public.knowledge_base USING gin(trigger_keywords) WHERE active = true;

DO $$ BEGIN
  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_kb_embedding_hnsw
      ON public.knowledge_base
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL AND active = true
    ';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE ''Skipping KB HNSW index: %'', SQLERRM;
  END;
END $$;

-- ============================================================
-- 4. KB DOCUMENTS — extend existing table with admin columns
-- ============================================================
-- kb_documents already exists from migration 020 (company-scoped for AI chat).
-- We add admin-level columns so it can serve dual purpose.

-- Make company_id/user_id nullable for platform-level documents
ALTER TABLE public.kb_documents ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE public.kb_documents ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.kb_documents ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE public.kb_documents ALTER COLUMN file_type DROP NOT NULL;
ALTER TABLE public.kb_documents ALTER COLUMN file_size DROP NOT NULL;

-- Add admin-level columns
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS issuer text,
  ADD COLUMN IF NOT EXISTS publication_date date,
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS full_text text,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS page_count int,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES auth.users(id);

-- Update status CHECK to include 'pending' and 'superseded'
ALTER TABLE public.kb_documents DROP CONSTRAINT IF EXISTS kb_documents_status_check;
ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_status_check
  CHECK (status IN ('uploading', 'pending', 'processing', 'ready', 'error', 'superseded'));

-- Admin RLS policies (additive to existing company-scoped policies)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_docs_admin_all' AND tablename = 'kb_documents') THEN
    CREATE POLICY "kb_docs_admin_all" ON public.kb_documents
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON public.kb_documents(status) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_tags ON public.kb_documents USING gin(tags) WHERE active = true;

-- ============================================================
-- 5. KB CHUNKS — extend existing table with admin columns
-- ============================================================
-- kb_chunks already exists from migration 020.
-- Add extra metadata columns for admin documents.

ALTER TABLE public.kb_chunks ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE public.kb_chunks
  ADD COLUMN IF NOT EXISTS page_number int,
  ADD COLUMN IF NOT EXISTS section_title text,
  ADD COLUMN IF NOT EXISTS article_reference text;

-- Admin RLS policies
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_chunks_admin_all' AND tablename = 'kb_chunks') THEN
    CREATE POLICY "kb_chunks_admin_all" ON public.kb_chunks
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_chunks_read' AND tablename = 'kb_chunks') THEN
    CREATE POLICY "kb_chunks_read" ON public.kb_chunks
      FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- FK da knowledge_base a kb_documents
ALTER TABLE public.knowledge_base
  ADD CONSTRAINT fk_kb_source_document
  FOREIGN KEY (source_document_id) REFERENCES public.kb_documents(id) ON DELETE SET NULL;

-- ============================================================
-- 6. AGENT CONFIG — system prompt e parametri per agent
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL UNIQUE CHECK (agent_type IN ('commercialista', 'revisore')),
  display_name text NOT NULL,
  description text,

  -- System prompt
  system_prompt text NOT NULL,

  -- Modello e parametri
  model text NOT NULL DEFAULT 'gemini-2.5-flash',
  model_escalation text DEFAULT 'gemini-3.1-pro-preview',
  temperature numeric(3,2) DEFAULT 0.1,
  thinking_level text DEFAULT 'medium' CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high')),
  max_output_tokens int DEFAULT 65536,

  -- Versioning
  version int NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.agent_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_config_admin_all' AND tablename = 'agent_config') THEN
    CREATE POLICY "agent_config_admin_all" ON public.agent_config
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_config_read' AND tablename = 'agent_config') THEN
    CREATE POLICY "agent_config_read" ON public.agent_config
      FOR SELECT USING (auth.uid() IS NOT NULL AND active = true);
  END IF;
END $$;

-- ============================================================
-- 7. AGENT RULES — regole operative per agent
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL CHECK (agent_type IN ('commercialista', 'revisore')),

  -- Contenuto
  title text NOT NULL,
  rule_text text NOT NULL,

  -- Trigger opzionali
  trigger_condition text,
  trigger_keywords text[] DEFAULT '{}',

  -- Stato e ordinamento
  priority int NOT NULL DEFAULT 50,
  sort_order int DEFAULT 0,
  active boolean NOT NULL DEFAULT true,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_rules_admin_all' AND tablename = 'agent_rules') THEN
    CREATE POLICY "agent_rules_admin_all" ON public.agent_rules
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_rules_read' AND tablename = 'agent_rules') THEN
    CREATE POLICY "agent_rules_read" ON public.agent_rules
      FOR SELECT USING (auth.uid() IS NOT NULL AND active = true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_rules_type ON public.agent_rules(agent_type) WHERE active = true;
