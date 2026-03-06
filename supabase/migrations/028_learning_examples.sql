-- =============================================
-- UNIFIED RAG LEARNING SYSTEM
-- learning_examples: ogni conferma utente diventa un esempio riutilizzabile
-- Domains: article_assignment, classification, reconciliation
-- =============================================

-- ─── learning_examples table ───────────────────────────
CREATE TABLE IF NOT EXISTS public.learning_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain IN ('article_assignment', 'classification', 'reconciliation')),
  input_text text NOT NULL,           -- contesto da classificare (descrizione riga, riassunto fattura, etc.)
  output_label text NOT NULL,         -- risposta confermata (codice articolo, categoria, "matched")
  metadata jsonb DEFAULT '{}',        -- dati specifici per dominio (article_id, category_id, etc.)
  embedding halfvec(3072),            -- Gemini embedding-001 (3072 dims)
  source_id text,                     -- deduplica: 'ila:<id>', 'ic:<id>', 'rl:<id>'
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.learning_examples ENABLE ROW LEVEL SECURITY;

CREATE POLICY learning_examples_all ON public.learning_examples FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = learning_examples.company_id AND cm.user_id = auth.uid()
  ));

-- ─── indexes ──────────────────────────────────────────
-- Composite for domain + company filtering (fast pre-filter before vector search)
CREATE INDEX IF NOT EXISTS idx_learning_examples_domain
  ON public.learning_examples(company_id, domain);

-- Uniqueness constraint for deduplication via source_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_examples_source_id
  ON public.learning_examples(company_id, source_id)
  WHERE source_id IS NOT NULL;

-- HNSW vector index for cosine similarity (same pattern as migration 020 kb_chunks)
DO $$
BEGIN
  BEGIN
    EXECUTE '
      CREATE INDEX IF NOT EXISTS idx_learning_examples_embedding_hnsw
      ON public.learning_examples
      USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
      WHERE embedding IS NOT NULL
    ';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE ''Skipping learning_examples ANN vector index: %'', SQLERRM;
  END;
END $$;

-- ─── search function ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_learning_examples(
  p_query_embedding halfvec(3072),
  p_company_id uuid,
  p_domain text,
  p_limit int DEFAULT 10
)
RETURNS TABLE(
  id uuid,
  input_text text,
  output_label text,
  metadata jsonb,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT le.id, le.input_text, le.output_label, le.metadata,
         (1 - (le.embedding <=> p_query_embedding))::float AS similarity
  FROM public.learning_examples le
  WHERE le.company_id = p_company_id
    AND le.domain = p_domain
    AND le.embedding IS NOT NULL
  ORDER BY le.embedding <=> p_query_embedding
  LIMIT LEAST(COALESCE(p_limit, 10), 50);
$$;

GRANT EXECUTE ON FUNCTION public.search_learning_examples(halfvec(3072), uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_learning_examples(halfvec(3072), uuid, text, int) TO service_role;

-- ─── data migration: populate from existing confirmed data ─

-- 1. Article assignments from verified invoice_line_articles
INSERT INTO public.learning_examples (company_id, domain, input_text, output_label, metadata, source_id)
SELECT
  ila.company_id,
  'article_assignment',
  COALESCE(il.description, '') ||
    ' | Fornitore: ' || COALESCE(c.name, 'N/D') ||
    ' | Quantita: ' || COALESCE(il.quantity::text, 'N/D'),
  art.code,
  jsonb_build_object(
    'article_id', ila.article_id,
    'article_name', art.name,
    'invoice_line_id', ila.invoice_line_id
  ),
  'ila:' || ila.id::text
FROM public.invoice_line_articles ila
JOIN public.invoice_lines il ON il.id = ila.invoice_line_id
JOIN public.articles art ON art.id = ila.article_id
LEFT JOIN public.invoices inv ON inv.id = il.invoice_id
LEFT JOIN public.counterparties c ON c.id = inv.counterparty_id
WHERE ila.verified = true
  AND il.description IS NOT NULL
  AND length(il.description) > 3
ON CONFLICT DO NOTHING;

-- 2. Classifications from invoice_classifications
INSERT INTO public.learning_examples (company_id, domain, input_text, output_label, metadata, source_id)
SELECT
  ic.company_id,
  'classification',
  'Fattura N.' || COALESCE(inv.number, 'N/D') ||
    ' | ' || COALESCE(inv.counterparty->>'denom', 'N/D') ||
    ' | ' || COALESCE(inv.total_amount::text, '0') || ' EUR',
  COALESCE(cat.name, '') || ' > ' || COALESCE(coa.code, '') || ' ' || COALESCE(coa.name, ''),
  jsonb_build_object(
    'category_id', ic.category_id,
    'account_id', ic.account_id,
    'invoice_id', ic.invoice_id
  ),
  'ic:' || ic.id::text
FROM public.invoice_classifications ic
JOIN public.invoices inv ON inv.id = ic.invoice_id
LEFT JOIN public.categories cat ON cat.id = ic.category_id
LEFT JOIN public.chart_of_accounts coa ON coa.id = ic.account_id
ON CONFLICT DO NOTHING;

-- 3. Reconciliations from reconciliation_log WHERE accepted = true
INSERT INTO public.learning_examples (company_id, domain, input_text, output_label, metadata, source_id)
SELECT
  rl.company_id,
  'reconciliation',
  'TX: ' || COALESCE(bt.description, '') || ' ' ||
    COALESCE(bt.date::text, '') || ' ' ||
    COALESCE(bt.amount::text, '0') || ' EUR' ||
    ' | INV: Fattura ' || COALESCE(inv.number, 'N/D') ||
    ' del ' || COALESCE(inv.date::text, '') || ' ' ||
    COALESCE(inv.total_amount::text, '0') || ' EUR',
  'matched',
  jsonb_build_object(
    'transaction_id', rl.bank_transaction_id,
    'invoice_id', rl.invoice_id,
    'installment_id', rl.installment_id,
    'match_score', rl.match_score
  ),
  'rl:' || rl.id::text
FROM public.reconciliation_log rl
JOIN public.bank_transactions bt ON bt.id = rl.bank_transaction_id
JOIN public.invoices inv ON inv.id = rl.invoice_id
WHERE rl.accepted = true
ON CONFLICT DO NOTHING;
