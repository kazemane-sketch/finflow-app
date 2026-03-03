CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_bank_tx_raw_text_trgm
  ON public.bank_transactions
  USING gin (raw_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bank_tx_description_trgm
  ON public.bank_transactions
  USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bank_tx_counterparty_trgm
  ON public.bank_transactions
  USING gin (counterparty_name gin_trgm_ops);
