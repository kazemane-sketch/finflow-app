-- 057: Reasoning separati + note per riga + thinking su invoice_lines

-- Reasoning del commercialista (Step 3)
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS classification_reasoning text;

-- Reasoning del revisore (Step 5)
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS fiscal_reasoning text;

-- Confidence del revisore (0-100)
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS fiscal_confidence int;

-- Note per riga (utente o AI)
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS line_note text;

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS line_note_source text
    CHECK (line_note_source IN ('user', 'ai_consultant', 'ai_reviewer'));

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS line_note_updated_at timestamptz;

-- Thinking text (per debug/trasparenza)
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS classification_thinking text;

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS fiscal_thinking text;

-- Comments
COMMENT ON COLUMN public.invoice_lines.classification_reasoning IS 'Reasoning del commercialista AI (Step 3): perché ha scelto quel conto/categoria';
COMMENT ON COLUMN public.invoice_lines.fiscal_reasoning IS 'Reasoning del revisore AI (Step 5): analisi fiscale, deducibilità, IVA, ritenute';
COMMENT ON COLUMN public.invoice_lines.fiscal_confidence IS 'Confidence del revisore (0-100)';
COMMENT ON COLUMN public.invoice_lines.line_note IS 'Nota per riga: motivazione inerenza, decisione consulente, o note utente';
COMMENT ON COLUMN public.invoice_lines.line_note_source IS 'Chi ha scritto la nota: user, ai_consultant, ai_reviewer';
COMMENT ON COLUMN public.invoice_lines.classification_thinking IS 'Thinking text del commercialista AI (per debug)';
COMMENT ON COLUMN public.invoice_lines.fiscal_thinking IS 'Thinking text del revisore AI (per debug)';
