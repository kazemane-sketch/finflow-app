-- 062: Restructure tax_codes with meaningful codes + new columns
-- Idempotent: safe to re-run

-- Add new columns
ALTER TABLE public.tax_codes
  ADD COLUMN IF NOT EXISTS is_reverse_charge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_exempt boolean DEFAULT false;

-- Delete old seed codes (company_id IS NULL = system templates)
DELETE FROM public.tax_codes WHERE company_id IS NULL;

-- Insert V2 codes
INSERT INTO public.tax_codes (company_id, codice, descrizione, aliquota, detraibilita_pct, natura, tipo, is_reverse_charge, is_exempt, normativa_ref, sort_order)
VALUES
-- Core acquisti
(null, 'ACQ_22',       'Acquisto ordinario IVA 22%',                   22, 100, null,    'acquisto', false, false, null, 10),
(null, 'ACQ_10',       'Acquisto ordinario IVA 10%',                   10, 100, null,    'acquisto', false, false, null, 20),
(null, 'ACQ_4',        'Acquisto ordinario IVA 4%',                     4, 100, null,    'acquisto', false, false, null, 30),
(null, 'ACQ_5',        'Acquisto ordinario IVA 5%',                     5, 100, null,    'acquisto', false, false, null, 35),
-- Detraibilità parziale
(null, 'ACQ_AUTO_40',  'Auto uso promiscuo (IVA detr. 40%)',           22,  40, null,    'acquisto', false, false, 'art. 19-bis1 c.1 lett. c) DPR 633/72', 100),
(null, 'ACQ_TEL_50',   'Telefonia (IVA detr. 50%)',                    22,  50, null,    'acquisto', false, false, 'art. 19-bis1 c.1 lett. f) DPR 633/72', 110),
(null, 'ACQ_IND_0',    'Acquisto IVA totalmente indetraibile',         22,   0, null,    'acquisto', false, false, 'art. 19-bis1 DPR 633/72', 120),
-- Natura IVA
(null, 'N1_ART15',     'Escluse art. 15 DPR 633/72',                   0,   0, 'N1',   'entrambi', false, true,  'art. 15 DPR 633/72', 200),
(null, 'N2_NON_SOGG',  'Non soggette',                                  0,   0, 'N2.2', 'entrambi', false, false, 'artt. 7-7septies DPR 633/72', 210),
(null, 'N3_NON_IMP',   'Non imponibili',                                0,   0, 'N3.1', 'entrambi', false, false, 'art. 8 DPR 633/72', 220),
(null, 'N4_ESENTE',    'Esenti art. 10',                                0,   0, 'N4',   'entrambi', false, true,  'art. 10 DPR 633/72', 230),
(null, 'RC_N6',        'Reverse charge',                                0, 100, 'N6.9', 'acquisto', true,  false, 'art. 17 DPR 633/72', 250),
-- Vendite
(null, 'VEND_22',      'Vendita ordinaria IVA 22%',                    22, 100, null,    'vendita',  false, false, null, 300),
(null, 'VEND_10',      'Vendita ordinaria IVA 10%',                    10, 100, null,    'vendita',  false, false, null, 310),
(null, 'VEND_4',       'Vendita ordinaria IVA 4%',                      4, 100, null,    'vendita',  false, false, null, 320)
ON CONFLICT DO NOTHING;
