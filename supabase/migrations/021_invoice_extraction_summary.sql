ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS extracted_summary jsonb DEFAULT NULL;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS extraction_model text;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS extracted_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_extraction_status_check'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_extraction_status_check
      CHECK (extraction_status IN ('pending', 'processing', 'ready', 'error', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_extraction_status
  ON public.invoices(company_id, extraction_status);

CREATE INDEX IF NOT EXISTS idx_invoices_extracted_summary_gin
  ON public.invoices USING gin (extracted_summary jsonb_path_ops);
