-- 031_counterparty_enrichment.sql
-- Add ATECO code and business enrichment fields to counterparties

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS ateco_code text;

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS ateco_description text;

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS business_sector text;

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS business_description text;

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS enrichment_source text;

ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

-- Constraint for enrichment_source
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'counterparties_enrichment_source_check'
      AND conrelid = 'public.counterparties'::regclass
  ) THEN
    ALTER TABLE public.counterparties
      ADD CONSTRAINT counterparties_enrichment_source_check
      CHECK (enrichment_source IN ('camerale', 'ai', 'manual'));
  END IF;
END $$;

-- Partial index: find counterparties that need enrichment
CREATE INDEX IF NOT EXISTS idx_counterparties_unenriched
  ON public.counterparties(company_id)
  WHERE enrichment_source IS NULL AND vat_key IS NOT NULL;

-- Index on business_sector for filtering
CREATE INDEX IF NOT EXISTS idx_counterparties_sector
  ON public.counterparties(company_id, business_sector)
  WHERE business_sector IS NOT NULL;
