-- Add extracted references columns to bank_transactions
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS extracted_refs jsonb DEFAULT NULL;

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS extraction_model text;

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS extracted_at timestamptz;

-- Add check constraint for extraction_status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_extraction_status_check'
      AND conrelid = 'public.bank_transactions'::regclass
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_transactions_extraction_status_check
      CHECK (extraction_status IN ('pending', 'processing', 'ready', 'error', 'skipped'));
  END IF;
END $$;

-- Index for finding pending extractions efficiently
CREATE INDEX IF NOT EXISTS idx_bank_tx_extraction_status
  ON public.bank_transactions(company_id, extraction_status);

-- GIN index for querying inside extracted_refs jsonb
CREATE INDEX IF NOT EXISTS idx_bank_tx_extracted_refs_gin
  ON public.bank_transactions USING gin (extracted_refs jsonb_path_ops);
