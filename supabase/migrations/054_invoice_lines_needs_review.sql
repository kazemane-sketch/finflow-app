-- Migration 054: Add needs_review + ai_confidence to invoice_lines
-- needs_review: boolean flag set by AI when confidence is low or fiscal doubts exist
-- ai_confidence: smallint (0-100), raw confidence from Gemini per-line

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_confidence smallint DEFAULT NULL;

COMMENT ON COLUMN public.invoice_lines.needs_review IS
  'True when AI confidence < 65, fiscal note contains verification keywords, or suggest_new_account is set';

COMMENT ON COLUMN public.invoice_lines.ai_confidence IS
  'Raw AI confidence 0-100 from classification. Stored per-line for badge rendering on reopen.';
