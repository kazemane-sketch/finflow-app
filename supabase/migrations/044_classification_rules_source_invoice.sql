-- 044_classification_rules_source_invoice.sql
-- Track which invoice created each classification rule.
-- Enables cleanup when a classification is cancelled:
-- soft-delete rules from that invoice (unless another confirmed invoice supports them).

ALTER TABLE public.classification_rules
  ADD COLUMN IF NOT EXISTS source_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_classification_rules_source_invoice
  ON public.classification_rules (source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;
