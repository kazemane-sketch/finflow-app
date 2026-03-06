-- Backfill: mark invoices that have AI classifications but were classified
-- before the classification_status column existed (they stayed 'none').
-- Only target invoices that are NOT already 'confirmed'.
UPDATE public.invoices
SET classification_status = 'ai_suggested'
WHERE classification_status = 'none'
  AND id IN (
    SELECT invoice_id FROM public.invoice_classifications
  );
