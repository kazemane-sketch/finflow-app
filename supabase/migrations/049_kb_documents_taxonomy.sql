-- 049_kb_documents_taxonomy.sql
-- KB Documents: rich taxonomy, applicability filters, temporal fields, relations graph
-- Company profile enrichment (legal_form, iva_periodicity, size_class, etc.)

-- ============================================================
-- 1. KB_DOCUMENTS — Add taxonomy columns (table already exists from 020+046)
-- ============================================================

-- 1a. Source classification
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS source_input_type text
    CHECK (source_input_type IN ('pdf', 'url', 'text')),
  ADD COLUMN IF NOT EXISTS authority text
    CHECK (authority IN (
      'tuir', 'dpr_633', 'dpr_600', 'codice_civile', 'oic', 'isa_italia',
      'agenzia_entrate', 'mef', 'cassazione', 'corte_costituzionale',
      'commissione_tributaria', 'cndcec', 'eu', 'altro'
    )),
  ADD COLUMN IF NOT EXISTS legal_reference text;

-- 1b. Overwrite source_type CHECK to add all normative types
-- (source_type column already exists from 046 as plain text, no CHECK)
-- We add the CHECK now
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'kb_documents_source_type_check' AND conrelid = 'public.kb_documents'::regclass
  ) THEN
    ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_source_type_check
      CHECK (source_type IS NULL OR source_type IN (
        'legge', 'dpr', 'dlgs', 'dm', 'dpcm',
        'circolare_ade', 'risoluzione_ade', 'interpello_ade',
        'principio_oic', 'principio_isa', 'sentenza',
        'prassi', 'normativa_eu', 'altro'
      ));
  END IF;
END $$;

-- 1c. Taxonomy
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS category text
    CHECK (category IN (
      'normativa_fiscale', 'principi_contabili', 'principi_revisione',
      'prassi_interpretativa', 'normativa_periodica', 'giurisprudenza',
      'tabelle_operative', 'normativa_lavoro', 'normativa_societaria'
    )),
  ADD COLUMN IF NOT EXISTS subcategory text,
  ADD COLUMN IF NOT EXISTS tax_area text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS accounting_area text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS topic_tags text[] DEFAULT '{}';

-- 1d. Applicability filters
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS applies_to_legal_forms text[],
  ADD COLUMN IF NOT EXISTS applies_to_regimes text[],
  ADD COLUMN IF NOT EXISTS applies_to_ateco_prefixes text[],
  ADD COLUMN IF NOT EXISTS applies_to_operations text[],
  ADD COLUMN IF NOT EXISTS applies_to_counterparty text[],
  ADD COLUMN IF NOT EXISTS applies_to_size text[],
  ADD COLUMN IF NOT EXISTS amount_threshold_min numeric,
  ADD COLUMN IF NOT EXISTS amount_threshold_max numeric;

-- 1e. Temporal fields
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS effective_from date DEFAULT '2000-01-01',
  ADD COLUMN IF NOT EXISTS effective_until date,
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.kb_documents(id),
  ADD COLUMN IF NOT EXISTS update_frequency text DEFAULT 'static'
    CHECK (update_frequency IN ('static', 'annual', 'periodic', 'volatile'));

-- 1f. Processing error
ALTER TABLE public.kb_documents
  ADD COLUMN IF NOT EXISTS processing_error text;

-- 1g. Update status CHECK to include 'chunking'
ALTER TABLE public.kb_documents DROP CONSTRAINT IF EXISTS kb_documents_status_check;
ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_status_check
  CHECK (status IN ('uploading', 'pending', 'processing', 'chunking', 'ready', 'error', 'superseded'));

-- 1h. Indexes for taxonomy filtering
CREATE INDEX IF NOT EXISTS idx_kb_docs_category ON public.kb_documents(category) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_source_type ON public.kb_documents(source_type) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_authority ON public.kb_documents(authority) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_effective ON public.kb_documents(effective_from, effective_until) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_tax_area ON public.kb_documents USING gin(tax_area) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_accounting_area ON public.kb_documents USING gin(accounting_area) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_topic_tags ON public.kb_documents USING gin(topic_tags) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_applies_forms ON public.kb_documents USING gin(applies_to_legal_forms) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_applies_regimes ON public.kb_documents USING gin(applies_to_regimes) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_applies_ateco ON public.kb_documents USING gin(applies_to_ateco_prefixes) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_applies_operations ON public.kb_documents USING gin(applies_to_operations) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_kb_docs_applies_counterparty ON public.kb_documents USING gin(applies_to_counterparty) WHERE active = true;

-- Updated_at trigger (if not exists)
CREATE OR REPLACE FUNCTION public.kb_docs_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_kb_docs_updated_at'
  ) THEN
    CREATE TRIGGER trg_kb_docs_updated_at
      BEFORE UPDATE ON public.kb_documents
      FOR EACH ROW EXECUTE FUNCTION public.kb_docs_updated_at();
  END IF;
END $$;

-- ============================================================
-- 2. KB_DOCUMENT_RELATIONS — Cross-reference graph
-- ============================================================
CREATE TABLE IF NOT EXISTS public.kb_document_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source: always a kb_document
  source_document_id uuid NOT NULL REFERENCES public.kb_documents(id) ON DELETE CASCADE,

  -- Target: can be another document OR a knowledge_base rule
  target_document_id uuid REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  target_rule_id uuid REFERENCES public.knowledge_base(id) ON DELETE CASCADE,

  -- Relation type
  relation_type text NOT NULL CHECK (relation_type IN (
    'rinvia_a', 'modifica', 'interpreta', 'abroga',
    'attua', 'deroga', 'integra', 'cita', 'genera_regola'
  )),

  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),

  -- At least one target must be non-null
  CONSTRAINT chk_has_target CHECK (
    target_document_id IS NOT NULL OR target_rule_id IS NOT NULL
  )
);

ALTER TABLE public.kb_document_relations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_rels_admin_all' AND tablename = 'kb_document_relations') THEN
    CREATE POLICY "kb_rels_admin_all" ON public.kb_document_relations
      FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_rels_authenticated_read' AND tablename = 'kb_document_relations') THEN
    CREATE POLICY "kb_rels_authenticated_read" ON public.kb_document_relations
      FOR SELECT USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kb_rels_source ON public.kb_document_relations(source_document_id);
CREATE INDEX IF NOT EXISTS idx_kb_rels_target_doc ON public.kb_document_relations(target_document_id) WHERE target_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_rels_target_rule ON public.kb_document_relations(target_rule_id) WHERE target_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_rels_type ON public.kb_document_relations(relation_type);

-- ============================================================
-- 3. COMPANIES — Enrich with fiscal profile
-- ============================================================
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS legal_form text CHECK (legal_form IN (
    'srl', 'spa', 'sapa', 'snc', 'sas', 'ss',
    'ditta_individuale', 'cooperativa',
    'associazione', 'fondazione', 'ente_non_commerciale',
    'consorzio', 'societa_tra_professionisti', 'altro'
  )),
  ADD COLUMN IF NOT EXISTS iva_periodicity text DEFAULT 'trimestrale' CHECK (iva_periodicity IN ('mensile', 'trimestrale')),
  ADD COLUMN IF NOT EXISTS size_class text CHECK (size_class IN ('micro', 'piccola', 'media', 'grande')),
  ADD COLUMN IF NOT EXISTS start_year int,
  ADD COLUMN IF NOT EXISTS revisione_legale boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS iva_special_regime text CHECK (iva_special_regime IN (
    'ordinario', 'agricoltura_speciale', 'agriturismo', 'editoria',
    'agenzie_viaggio', 'beni_usati', 'intrattenimento', 'altro'
  ));

COMMENT ON COLUMN public.companies.legal_form IS 'Forma giuridica: determina regime fiscale, obblighi bilancio, trasparenza fiscale';
COMMENT ON COLUMN public.companies.size_class IS 'Micro(<350K attivo), Piccola(<6M), Media(<20M), Grande(>20M) — soglie normative';
COMMENT ON COLUMN public.companies.iva_periodicity IS 'Periodicità liquidazione IVA';
COMMENT ON COLUMN public.companies.revisione_legale IS 'Soggetta a revisione legale dei conti';
COMMENT ON COLUMN public.companies.iva_special_regime IS 'Regime IVA speciale (se diverso da ordinario)';

-- ============================================================
-- 4. Update CAVECO with new fields
-- ============================================================
UPDATE public.companies SET
  legal_form = 'srl',
  iva_periodicity = 'trimestrale',
  size_class = 'piccola',
  revisione_legale = false,
  iva_special_regime = 'ordinario'
WHERE id = '9f215045-578a-4c9d-af92-ca7cb9da01fe';
