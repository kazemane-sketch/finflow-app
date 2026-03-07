-- 034: Add missing classification columns to invoice_lines and invoice_classifications
-- Required by the unified classify-invoice-lines edge function to persist
-- line-level and invoice-level AI classification results.

-- ─── invoice_lines: category + account for line-level classification ───
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

-- ─── invoice_classifications: AI confidence + reasoning ───
ALTER TABLE public.invoice_classifications
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(5,2);

ALTER TABLE public.invoice_classifications
  ADD COLUMN IF NOT EXISTS ai_reasoning text;

-- ─── Expand assigned_by on invoice_line_articles to include 'ai_classification' ───
ALTER TABLE public.invoice_line_articles
  DROP CONSTRAINT IF EXISTS invoice_line_articles_assigned_by_check;

ALTER TABLE public.invoice_line_articles
  ADD CONSTRAINT invoice_line_articles_assigned_by_check
  CHECK (assigned_by IN ('manual', 'ai_auto', 'ai_confirmed', 'ai_classification'));
