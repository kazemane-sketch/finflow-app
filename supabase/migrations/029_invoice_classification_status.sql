-- Add classification_status to invoices for visual AI suggestion tracking
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS classification_status text
DEFAULT 'none'
CHECK (classification_status IN ('none', 'ai_suggested', 'confirmed'));

-- Backfill: mark invoices that already have a verified classification as 'confirmed'
UPDATE public.invoices i
SET classification_status = 'confirmed'
WHERE EXISTS (
  SELECT 1 FROM public.invoice_classifications ic
  WHERE ic.invoice_id = i.id AND ic.verified = true
);

-- Index for filtering AI-suggested invoices
CREATE INDEX IF NOT EXISTS idx_invoices_classification_status
ON public.invoices (company_id, classification_status)
WHERE classification_status = 'ai_suggested';
