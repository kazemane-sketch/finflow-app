-- =============================================
-- CLASSIFICATION STATUS on invoice_lines
-- =============================================
-- Tracks whether a line is pending analysis, classified (assigned to article),
-- or skipped (marked as non-classifiable by the user).

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS classification_status text NOT NULL DEFAULT 'pending';

-- Add check constraint separately (IF NOT EXISTS not supported for constraints)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_classification_status_check'
  ) THEN
    ALTER TABLE public.invoice_lines
      ADD CONSTRAINT invoice_lines_classification_status_check
      CHECK (classification_status IN ('pending', 'classified', 'skipped'));
  END IF;
END$$;

-- Index for fast filtering of skipped lines
CREATE INDEX IF NOT EXISTS idx_invoice_lines_classification_status
  ON public.invoice_lines(classification_status)
  WHERE classification_status = 'skipped';

-- UPDATE policy on invoice_lines (only SELECT + INSERT existed before)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'invoice_lines' AND policyname = 'il_update'
  ) THEN
    CREATE POLICY "il_update" ON public.invoice_lines FOR UPDATE USING (
      EXISTS (SELECT 1 FROM public.invoices i WHERE i.id = invoice_id AND is_company_member(i.company_id))
    );
  END IF;
END$$;

-- Backfill: mark already-classified lines (those with an entry in invoice_line_articles)
UPDATE public.invoice_lines il
SET classification_status = 'classified'
WHERE EXISTS (
  SELECT 1 FROM public.invoice_line_articles ila WHERE ila.invoice_line_id = il.id
)
AND il.classification_status = 'pending';
