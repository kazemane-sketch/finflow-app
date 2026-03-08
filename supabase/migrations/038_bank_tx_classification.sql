-- Classificazione contabile per movimenti bancari senza fattura
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS category_id uuid,
  ADD COLUMN IF NOT EXISTS account_id uuid,
  ADD COLUMN IF NOT EXISTS cost_center_id uuid,
  ADD COLUMN IF NOT EXISTS classification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS classification_source text,
  ADD COLUMN IF NOT EXISTS classification_confidence numeric(5,2),
  ADD COLUMN IF NOT EXISTS classification_reasoning text,
  ADD COLUMN IF NOT EXISTS fiscal_flags jsonb,
  ADD COLUMN IF NOT EXISTS tx_nature text;

-- Check constraints
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_classification_status_check'
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_tx_classification_status_check
      CHECK (classification_status IN ('pending','ai_suggested','confirmed','excluded'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_tx_nature_check'
  ) THEN
    ALTER TABLE public.bank_transactions
      ADD CONSTRAINT bank_tx_nature_check
      CHECK (tx_nature IN ('invoice_payment','no_invoice','giro_conto') OR tx_nature IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_tx_classification
  ON public.bank_transactions(company_id, classification_status)
  WHERE reconciliation_status IN ('unmatched', 'excluded');

CREATE INDEX IF NOT EXISTS idx_bank_tx_nature
  ON public.bank_transactions(company_id, tx_nature)
  WHERE tx_nature IS NOT NULL;
