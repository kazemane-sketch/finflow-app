-- 048: Add contract_ref to classification_rules and fiscal_decisions
-- Enables per-contract matching for leasing and similar scenarios where
-- the same counterparty + description maps to different accounts/fiscal rules.

-- 1. contract_ref on classification_rules
ALTER TABLE public.classification_rules
  ADD COLUMN IF NOT EXISTS contract_ref text;

COMMENT ON COLUMN public.classification_rules.contract_ref IS
  'Riferimento contratto dalla fattura XML (DatiContratto.IdDocumento). Se presente, il match richiede lo stesso riferimento.';

-- 2. contract_ref and account_id on fiscal_decisions
ALTER TABLE public.fiscal_decisions
  ADD COLUMN IF NOT EXISTS contract_ref text,
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.fiscal_decisions.contract_ref IS
  'Riferimento contratto (DatiContratto.IdDocumento). Se presente, il match richiede lo stesso riferimento.';
COMMENT ON COLUMN public.fiscal_decisions.account_id IS
  'Conto contabile associato alla decisione. Se presente, il match richiede lo stesso conto.';

-- 3. Update unique index on fiscal_decisions to include contract_ref + account_id
DROP INDEX IF EXISTS idx_fd_dedup;
CREATE UNIQUE INDEX idx_fd_dedup
  ON public.fiscal_decisions(
    company_id, counterparty_vat_key, operation_group_code,
    direction, alert_type,
    COALESCE(contract_ref, ''),
    COALESCE(account_id::text, ''),
    COALESCE(description_pattern, '')
  );
