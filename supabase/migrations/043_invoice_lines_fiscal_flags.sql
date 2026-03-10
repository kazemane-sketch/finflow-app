-- 043: Add fiscal_flags jsonb column to invoice_lines
-- Persists AI-classified fiscal metadata per line for export (prima nota),
-- billing, and future fiscal analysis.
--
-- Structure: {
--   "ritenuta_acconto": { "aliquota": 20, "base": "100%" } | null,
--   "reverse_charge": false,
--   "split_payment": false,
--   "bene_strumentale": false,
--   "deducibilita_pct": 100,
--   "iva_detraibilita_pct": 100,
--   "note": null
-- }

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS fiscal_flags jsonb;

COMMENT ON COLUMN public.invoice_lines.fiscal_flags IS
  'AI-classified fiscal metadata: ritenuta, reverse charge, split payment, deducibilità, IVA detraibilità';
