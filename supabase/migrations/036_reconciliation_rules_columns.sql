-- 036: Add rule_name, rule_data to reconciliation_rules + unique constraint
-- Needed by Miglioria 3 (learned rules from confirmed reconciliations)

ALTER TABLE public.reconciliation_rules
  ADD COLUMN IF NOT EXISTS rule_name text;

ALTER TABLE public.reconciliation_rules
  ADD COLUMN IF NOT EXISTS rule_data jsonb;

-- Unique constraint for upsert on company_id + rule_name
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_rules_unique_name
  ON public.reconciliation_rules(company_id, rule_name)
  WHERE rule_name IS NOT NULL;
