-- 061_fiscal_architecture_v1.sql
-- V1 fiscal architecture: tax_codes, fiscal_parameters, agent_tools,
-- new columns on chart_of_accounts, invoice_lines, invoices, counterparties, companies.
-- Fully idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS, ON CONFLICT DO NOTHING.

-- ============================================================
-- 1.1 — tax_codes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tax_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  codice text NOT NULL,
  descrizione text NOT NULL,
  aliquota numeric(5,2) NOT NULL,
  detraibilita_pct smallint NOT NULL DEFAULT 100,
  natura text,
  tipo text DEFAULT 'acquisto' CHECK (tipo IN ('acquisto', 'vendita', 'entrambi')),
  normativa_ref text,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_codes_company ON public.tax_codes(company_id);
CREATE INDEX IF NOT EXISTS idx_tax_codes_codice ON public.tax_codes(codice);

ALTER TABLE public.tax_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tc_select" ON public.tax_codes;
CREATE POLICY "tc_select" ON public.tax_codes FOR SELECT USING (
  company_id IS NULL OR EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = tax_codes.company_id AND cm.user_id = auth.uid())
);
DROP POLICY IF EXISTS "tc_modify" ON public.tax_codes;
CREATE POLICY "tc_modify" ON public.tax_codes FOR ALL USING (
  (company_id IS NULL AND is_platform_admin())
  OR EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = tax_codes.company_id AND cm.user_id = auth.uid())
);

-- ============================================================
-- 1.2 — Seed tax_codes (~35 codici IVA italiani)
-- ============================================================
INSERT INTO public.tax_codes (company_id, codice, descrizione, aliquota, detraibilita_pct, natura, tipo, normativa_ref, sort_order) VALUES
-- Acquisti ordinari
(null, '22',     'IVA 22%',                              22, 100, null,    'acquisto', null, 10),
(null, '10',     'IVA 10%',                              10, 100, null,    'acquisto', null, 20),
(null, '5',      'IVA 5%',                                5, 100, null,    'acquisto', null, 30),
(null, '4',      'IVA 4%',                                4, 100, null,    'acquisto', null, 40),
-- Detraibilità parziale
(null, '22A40',  'IVA 22% Auto promiscua (detr. 40%)',   22,  40, null,    'acquisto', 'art. 19-bis1 c.1 lett. c) DPR 633/72', 100),
(null, '22A100', 'IVA 22% Auto strumentale (detr. 100%)',22, 100, null,    'acquisto', 'art. 19-bis1 — uso esclusivo', 101),
(null, '22T50',  'IVA 22% Telefonia (detr. 50%)',        22,  50, null,    'acquisto', 'art. 19-bis1 c.1 lett. f) DPR 633/72', 110),
(null, '22I0',   'IVA 22% Totalmente indetraibile',      22,   0, null,    'acquisto', 'art. 19-bis1 DPR 633/72', 120),
(null, '10A40',  'IVA 10% Auto promiscua (detr. 40%)',   10,  40, null,    'acquisto', 'art. 19-bis1 c.1 lett. c) DPR 633/72', 130),
-- Natura IVA (operazioni senza IVA)
(null, 'N1',     'Escluse art. 15',                       0,   0, 'N1',   'entrambi', 'art. 15 DPR 633/72', 200),
(null, 'N2.1',   'Non soggette art. 7-7septies',          0,   0, 'N2.1', 'entrambi', 'artt. 7-7septies DPR 633/72', 210),
(null, 'N2.2',   'Non soggette — altri casi',             0,   0, 'N2.2', 'entrambi', null, 211),
(null, 'N3.1',   'Non imponibili — esportazioni',         0,   0, 'N3.1', 'entrambi', 'art. 8 lett. a) DPR 633/72', 220),
(null, 'N3.2',   'Non imponibili — cessioni intra-UE',    0,   0, 'N3.2', 'entrambi', 'art. 41 DL 331/93', 221),
(null, 'N3.3',   'Non imponibili — S.Marino/Vaticano',    0,   0, 'N3.3', 'entrambi', null, 222),
(null, 'N3.4',   'Non imponibili — assimilate export',    0,   0, 'N3.4', 'entrambi', 'art. 8-bis DPR 633/72', 223),
(null, 'N3.5',   'Non imponibili — dich. intento',        0,   0, 'N3.5', 'entrambi', 'art. 8 lett. c) DPR 633/72', 224),
(null, 'N3.6',   'Non imponibili — altre',                0,   0, 'N3.6', 'entrambi', null, 225),
(null, 'N4',     'Esenti art. 10',                        0,   0, 'N4',   'entrambi', 'art. 10 DPR 633/72', 230),
(null, 'N5',     'Regime del margine',                     0,   0, 'N5',   'entrambi', 'DL 41/95', 240),
(null, 'N6.1',   'RC — cessione rottami',                  0, 100, 'N6.1', 'acquisto', 'art. 74 c.7-8 DPR 633/72', 250),
(null, 'N6.2',   'RC — oro/argento',                       0, 100, 'N6.2', 'acquisto', 'art. 17 c.5 DPR 633/72', 251),
(null, 'N6.3',   'RC — subappalto edile',                  0, 100, 'N6.3', 'acquisto', 'art. 17 c.6 lett. a)', 252),
(null, 'N6.4',   'RC — cessione fabbricati',               0, 100, 'N6.4', 'acquisto', 'art. 17 c.6 lett. a-bis)', 253),
(null, 'N6.5',   'RC — cellulari',                         0, 100, 'N6.5', 'acquisto', 'art. 17 c.6 lett. b)', 254),
(null, 'N6.6',   'RC — prodotti elettronici',              0, 100, 'N6.6', 'acquisto', 'art. 17 c.6 lett. c)', 255),
(null, 'N6.7',   'RC — servizi edili',                     0, 100, 'N6.7', 'acquisto', 'art. 17 c.6 lett. a-ter)', 256),
(null, 'N6.8',   'RC — energetici',                        0, 100, 'N6.8', 'acquisto', 'art. 17 c.6 lett. d-bis)', 257),
(null, 'N6.9',   'RC — altri casi',                        0, 100, 'N6.9', 'acquisto', null, 258),
(null, 'N7',     'IVA assolta in altro stato UE',          0,   0, 'N7',   'entrambi', null, 260),
-- Vendite
(null, 'V22',    'IVA 22% vendita',  22, 100, null, 'vendita', null, 300),
(null, 'V10',    'IVA 10% vendita',  10, 100, null, 'vendita', null, 310),
(null, 'V5',     'IVA 5% vendita',    5, 100, null, 'vendita', null, 320),
(null, 'V4',     'IVA 4% vendita',    4, 100, null, 'vendita', null, 330)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 1.3 — fiscal_parameters
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fiscal_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codice text UNIQUE NOT NULL,
  nome text NOT NULL,
  categoria text NOT NULL CHECK (categoria IN ('ires', 'iva', 'irap', 'ritenute', 'cespiti', 'soglie', 'bollo', 'altro')),
  valore_numerico numeric(15,4),
  valore_testo text,
  unita text CHECK (unita IN ('percentuale', 'importo_euro', 'booleano', 'codice', 'formula')),
  normativa_ref text NOT NULL,
  normativa_dettaglio text,
  valido_dal date NOT NULL,
  valido_al date,
  usato_in text[],
  impatta text[],
  aggiornato_da text,
  aggiornato_il timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fp_codice ON public.fiscal_parameters(codice);

ALTER TABLE public.fiscal_parameters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fp_select" ON public.fiscal_parameters;
CREATE POLICY "fp_select" ON public.fiscal_parameters FOR SELECT USING (true);
DROP POLICY IF EXISTS "fp_admin" ON public.fiscal_parameters;
CREATE POLICY "fp_admin" ON public.fiscal_parameters FOR ALL USING (is_platform_admin());

-- ============================================================
-- 1.4 — Seed fiscal_parameters (18 parametri normativi)
-- ============================================================
INSERT INTO public.fiscal_parameters (codice, nome, categoria, valore_numerico, unita, normativa_ref, normativa_dettaglio, valido_dal, valido_al) VALUES
('art_164_auto_promiscua_deduc', 'Deducibilità auto promiscua', 'ires', 20, 'percentuale', 'art. 164 c.1 lett. b) TUIR', null, '2013-01-01', null),
('art_164_auto_tetto', 'Tetto costo auto', 'ires', 18075.99, 'importo_euro', 'art. 164 c.1 lett. b) TUIR', null, '2013-01-01', null),
('art_164_auto_agenti_deduc', 'Deducibilità auto agenti', 'ires', 80, 'percentuale', 'art. 164 c.1 lett. b-bis) TUIR', null, '2013-01-01', null),
('art_164_auto_agenti_tetto', 'Tetto auto agenti', 'ires', 25822.84, 'importo_euro', 'art. 164 c.1 lett. b-bis) TUIR', null, '2013-01-01', null),
('art_164_auto_dipendenti_deduc', 'Deducibilità auto dipendenti', 'ires', 70, 'percentuale', 'art. 164 c.1 lett. b-bis) TUIR', null, '2013-01-01', null),
('art_102c9_telefonia_deduc', 'Deducibilità telefonia', 'ires', 80, 'percentuale', 'art. 102 c.9 TUIR', null, '2007-01-01', null),
('art_109c5_vitto_deduc', 'Deducibilità vitto e alloggio', 'ires', 75, 'percentuale', 'art. 109 c.5 TUIR', null, '2009-01-01', null),
('art_108_rappr_fascia1', 'Rappresentanza fino 10M', 'ires', 1.5, 'percentuale', 'art. 108 c.2 TUIR + DM 19/11/2008', null, '2016-01-01', null),
('soglia_bene_strumentale', 'Soglia capitalizzazione', 'cespiti', 516.46, 'importo_euro', 'art. 102 TUIR', null, '2001-01-01', null),
('art_96_rol_limite', 'Limite interessi su ROL', 'ires', 30, 'percentuale', 'art. 96 TUIR', null, '2019-01-01', null),
('art_25_ritenuta_prof', 'Ritenuta lavoro autonomo', 'ritenute', 20, 'percentuale', 'art. 25 DPR 600/73', null, '1973-01-01', null),
('art_25bis_provv_aliquota', 'Ritenuta provvigioni aliquota', 'ritenute', 23, 'percentuale', 'art. 25-bis DPR 600/73', null, '1983-01-01', null),
('art_25bis_provv_base', 'Ritenuta provvigioni base', 'ritenute', 50, 'percentuale', 'art. 25-bis DPR 600/73', '23% sul 50%', '1983-01-01', null),
('bollo_soglia', 'Soglia bollo fatture esenti', 'bollo', 77.47, 'importo_euro', 'DPR 642/72', null, '2014-01-01', null),
('bollo_importo', 'Importo bollo', 'bollo', 2.00, 'importo_euro', 'DPR 642/72', null, '2014-01-01', null),
('ires_aliquota', 'Aliquota IRES', 'ires', 24, 'percentuale', 'art. 77 TUIR', null, '2017-01-01', null),
('ires_premiale_2025', 'IRES premiale 2025', 'ires', 20, 'percentuale', 'LdB 2026', 'Solo anno 2025', '2025-01-01', '2025-12-31'),
('irap_aliquota', 'Aliquota IRAP', 'irap', 3.9, 'percentuale', 'D.Lgs. 446/97', null, '1998-01-01', null)
ON CONFLICT (codice) DO NOTHING;

-- ============================================================
-- 1.5 — Nuove colonne su chart_of_accounts
-- ============================================================
ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS default_tax_code_id uuid REFERENCES public.tax_codes(id),
  ADD COLUMN IF NOT EXISTS default_ires_pct smallint,
  ADD COLUMN IF NOT EXISTS default_irap_mode text DEFAULT 'follows_ires'
    CHECK (default_irap_mode IN ('follows_ires', 'fully_indeducible', 'custom_pct')),
  ADD COLUMN IF NOT EXISTS default_irap_pct smallint,
  ADD COLUMN IF NOT EXISTS needs_user_confirmation boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS note_fiscali text;

-- ============================================================
-- 1.6 — Nuove colonne su invoice_lines (blocchi A-G)
-- ============================================================

-- A. IVA
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code_id uuid REFERENCES public.tax_codes(id),
  ADD COLUMN IF NOT EXISTS iva_detraibilita_pct smallint DEFAULT 100,
  ADD COLUMN IF NOT EXISTS iva_importo numeric(15,2),
  ADD COLUMN IF NOT EXISTS iva_detraibile numeric(15,2),
  ADD COLUMN IF NOT EXISTS iva_indetraibile numeric(15,2),
  ADD COLUMN IF NOT EXISTS iva_importo_source text DEFAULT 'xml'
    CHECK (iva_importo_source IN ('xml', 'recomputed', 'manual_override')),
  ADD COLUMN IF NOT EXISTS reverse_charge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS split_payment boolean DEFAULT false;

-- B. IRES / IRAP
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS deducibilita_ires_pct smallint DEFAULT 100,
  ADD COLUMN IF NOT EXISTS costo_fiscale numeric(15,2),
  ADD COLUMN IF NOT EXISTS importo_deducibile_ires numeric(15,2),
  ADD COLUMN IF NOT EXISTS importo_indeducibile_ires numeric(15,2),
  ADD COLUMN IF NOT EXISTS irap_mode text DEFAULT 'follows_ires'
    CHECK (irap_mode IN ('follows_ires', 'fully_indeducible', 'custom_pct', 'personale')),
  ADD COLUMN IF NOT EXISTS irap_pct smallint,
  ADD COLUMN IF NOT EXISTS importo_deducibile_irap numeric(15,2),
  ADD COLUMN IF NOT EXISTS costo_personale boolean DEFAULT false;

-- C. COMPETENZA
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS competenza_dal date,
  ADD COLUMN IF NOT EXISTS competenza_al date,
  ADD COLUMN IF NOT EXISTS importo_competenza numeric(15,2),
  ADD COLUMN IF NOT EXISTS importo_risconto numeric(15,2);

-- D. RITENUTE
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS ritenuta_applicabile boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ritenuta_tipo text
    CHECK (ritenuta_tipo IN ('lavoro_autonomo', 'occasionale', 'provvigioni', 'none')),
  ADD COLUMN IF NOT EXISTS ritenuta_aliquota_pct smallint,
  ADD COLUMN IF NOT EXISTS ritenuta_base_pct smallint DEFAULT 100,
  ADD COLUMN IF NOT EXISTS ritenuta_importo numeric(15,2),
  ADD COLUMN IF NOT EXISTS cassa_previdenziale_pct numeric(5,2);

-- E. CESPITI
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS bene_strumentale boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS asset_candidate boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS asset_category_guess text,
  ADD COLUMN IF NOT EXISTS ammortamento_aliquota_proposta numeric(5,2),
  ADD COLUMN IF NOT EXISTS capitalization_reason text,
  ADD COLUMN IF NOT EXISTS cespite_id uuid;

-- F. DEBITO / INTERESSI
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS debt_related boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS debt_type text
    CHECK (debt_type IN ('leasing', 'mutuo', 'finanziamento')),
  ADD COLUMN IF NOT EXISTS interest_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS principal_amount numeric(15,2);

-- G. CONTESTO AI
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS warning_flags text[],
  ADD COLUMN IF NOT EXISTS user_answer_summary text,
  ADD COLUMN IF NOT EXISTS note_for_accountant text,
  ADD COLUMN IF NOT EXISTS fiscal_reasoning_short text;

-- ============================================================
-- 1.7 — Nuove colonne su invoices
-- ============================================================
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS data_ricezione_sdi date,
  ADD COLUMN IF NOT EXISTS data_registrazione_iva date,
  ADD COLUMN IF NOT EXISTS registration_period text,
  ADD COLUMN IF NOT EXISTS documento_originario_id uuid REFERENCES public.invoices(id),
  ADD COLUMN IF NOT EXISTS tipo_collegamento text
    CHECK (tipo_collegamento IN ('nota_credito_di', 'autofattura_per', 'integrazione_di')),
  ADD COLUMN IF NOT EXISTS bollo_dovuto boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bollo_importo numeric(5,2) DEFAULT 2.00;

-- ============================================================
-- 1.8 — Nuove colonne su counterparties
-- ============================================================
ALTER TABLE public.counterparties
  ADD COLUMN IF NOT EXISTS tipo_soggetto text
    CHECK (tipo_soggetto IN ('societa_capitali', 'societa_persone', 'persona_fisica', 'professionista', 'pa', 'ente_non_commerciale', 'estero_ue', 'estero_extra_ue')),
  ADD COLUMN IF NOT EXISTS soggetto_a_ritenuta boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS cassa_previdenziale text,
  ADD COLUMN IF NOT EXISTS split_payment_soggetto boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS paese_residenza text DEFAULT 'IT';

-- ============================================================
-- 1.9 — Nuova colonna su companies
-- ============================================================
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS iva_per_cassa boolean DEFAULT false;

-- ============================================================
-- 1.10 — agent_tools + aggiornamenti admin
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL,
  tool_name text NOT NULL,
  display_name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(agent_type, tool_name)
);

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_tools_read" ON public.agent_tools;
CREATE POLICY "agent_tools_read" ON public.agent_tools FOR SELECT USING (true);
DROP POLICY IF EXISTS "agent_tools_admin" ON public.agent_tools;
CREATE POLICY "agent_tools_admin" ON public.agent_tools FOR ALL USING (is_platform_admin());

-- Seed tool per commercialista (7 tool)
INSERT INTO public.agent_tools (agent_type, tool_name, display_name, description, sort_order) VALUES
('commercialista', 'cerca_conti',           'Cerca conti',            'Cerca nel piano dei conti per parole chiave o sezione', 1),
('commercialista', 'get_defaults_conto',    'Default fiscali conto',  'Legge i default fiscali di un conto specifico (IRES, IRAP, tax code)', 2),
('commercialista', 'storico_controparte',   'Storico controparte',    'Cerca classificazioni confermate per controparte + descrizione', 3),
('commercialista', 'get_tax_codes',         'Codici IVA',             'Cerca codici IVA disponibili per aliquota e tipo', 4),
('commercialista', 'get_parametro_fiscale', 'Parametri fiscali',      'Cerca parametri normativi (soglie, aliquote, limiti)', 5),
('commercialista', 'get_profilo_controparte','Profilo controparte',   'Legge tipo soggetto, ritenuta, cassa, split payment', 6),
('commercialista', 'consulta_kb',           'Consulta KB',            'Cerca nella knowledge base note consultive e fonti normative', 7),
-- Seed tool per consulente/CFO (11 tool = 7 condivisi + 4 esclusivi)
('consulente', 'cerca_conti',           'Cerca conti',            'Cerca nel piano dei conti per parole chiave o sezione', 1),
('consulente', 'get_defaults_conto',    'Default fiscali conto',  'Legge i default fiscali di un conto specifico', 2),
('consulente', 'storico_controparte',   'Storico controparte',    'Cerca classificazioni confermate per controparte', 3),
('consulente', 'get_tax_codes',         'Codici IVA',             'Cerca codici IVA disponibili', 4),
('consulente', 'get_parametro_fiscale', 'Parametri fiscali',      'Cerca parametri normativi', 5),
('consulente', 'get_profilo_controparte','Profilo controparte',   'Legge profilo fiscale della controparte', 6),
('consulente', 'consulta_kb',           'Consulta KB',            'Cerca note consultive KB (approfondita)', 7),
('consulente', 'get_bilancio_pnl',      'Bilancio P&L',           'Legge il conto economico aggregato (ricavi, costi, EBITDA)', 8),
('consulente', 'get_saldi_conti',       'Saldi conti',            'Legge i saldi per conto, mese, anno dalla materialized view', 9),
('consulente', 'get_budget_fiscale',    'Budget fiscali',         'Legge i budget fiscali (rappresentanza, veicoli, telefonia)', 10),
('consulente', 'get_storico_decisioni', 'Storico decisioni',      'Cerca decisioni fiscali passate su alert simili', 11)
ON CONFLICT (agent_type, tool_name) DO NOTHING;

-- Disattiva revisore
UPDATE public.agent_config SET active = false, updated_at = now() WHERE agent_type = 'revisore';

-- Aggiorna agent_rules CHECK per includere consulente
ALTER TABLE public.agent_rules
  DROP CONSTRAINT IF EXISTS agent_rules_agent_type_check;
ALTER TABLE public.agent_rules
  ADD CONSTRAINT agent_rules_agent_type_check
  CHECK (agent_type IN ('commercialista', 'revisore', 'consulente', 'kb_classifier'));
