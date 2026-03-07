-- 033: Expand invoice_lines.classification_status constraint
-- Add 'ai_suggested' and 'confirmed' to support the new unified classifier flow
-- where classification suggestions live on individual lines, not just at invoice level.

ALTER TABLE public.invoice_lines
  DROP CONSTRAINT IF EXISTS invoice_lines_classification_status_check;

ALTER TABLE public.invoice_lines
  ADD CONSTRAINT invoice_lines_classification_status_check
  CHECK (classification_status IN ('pending','classified','skipped','ai_suggested','confirmed'));
