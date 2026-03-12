-- 053: Add bank transaction notes + persisted invoice contract refs
-- Used by reconciliation ranking, memory and embeddings.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.bank_transactions.notes IS
  'Nota utente sul movimento bancario. Può influenzare riconciliazione, ranking e RAG.';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS primary_contract_ref text,
  ADD COLUMN IF NOT EXISTS contract_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.invoices.primary_contract_ref IS
  'Riferimento contratto principale estratto da DatiContratto.IdDocumento.';

COMMENT ON COLUMN public.invoices.contract_refs IS
  'Array dei riferimenti contratto estratti da DatiContratto.IdDocumento.';

CREATE INDEX IF NOT EXISTS idx_invoices_primary_contract_ref
  ON public.invoices(primary_contract_ref)
  WHERE primary_contract_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_contract_refs_gin
  ON public.invoices USING gin (contract_refs jsonb_path_ops);
