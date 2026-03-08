-- Migration 039: Chart of Accounts templates for onboarding
-- Three sectors: commercio, servizi, manifattura_costruzioni
-- Each sector gets a COMPLETE set (shared base + sector-specific overrides)

-- ─── Table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.coa_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  sector text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  section text NOT NULL CHECK (section IN (
    'assets', 'liabilities', 'equity', 'revenue',
    'cost_production', 'cost_personnel', 'depreciation',
    'other_costs', 'financial', 'extraordinary'
  )),
  parent_code text,
  is_header boolean DEFAULT false,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coa_template_sector_code
  ON public.coa_templates(sector, code);

ALTER TABLE public.coa_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coa_templates_read" ON public.coa_templates FOR SELECT USING (true);

-- ─── Helper: insert base common accounts for a given sector ────

-- We use a DO block with a function to avoid repeating ~70 INSERT lines × 3 sectors

CREATE OR REPLACE FUNCTION _tmp_insert_coa_base(p_sector text) RETURNS void AS $$
BEGIN
  -- ═══ ATTIVO PATRIMONIALE (assets) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '20',    'Immobilizzazioni immateriali',       'assets', NULL, true),
    (p_sector, '21',    'Immobilizzazioni materiali',         'assets', NULL, true),
    (p_sector, '21100', 'Impianti e macchinari',              'assets', '21', false),
    (p_sector, '21200', 'Attrezzature',                       'assets', '21', false),
    (p_sector, '21300', 'Autoveicoli',                        'assets', '21', false),
    (p_sector, '21301', 'Autovetture',                        'assets', '21', false),
    (p_sector, '21320', 'Macchine ufficio elettroniche',      'assets', '21', false),
    (p_sector, '21322', 'Mobili e arredi ufficio',            'assets', '21', false),
    (p_sector, '21360', 'Beni strumentali inf. 516 euro',    'assets', '21', false),
    (p_sector, '22',    'Immobilizzazioni finanziarie',       'assets', NULL, true),
    (p_sector, '22700', 'Titoli e partecipazioni',            'assets', '22', false),
    (p_sector, '31',    'Rimanenze',                          'assets', NULL, true),
    (p_sector, '31100', 'Rimanenze materie prime',            'assets', '31', false),
    (p_sector, '31200', 'Rimanenze prodotti finiti',          'assets', '31', false),
    (p_sector, '40',    'Clienti',                            'assets', NULL, true),
    (p_sector, '40000', 'Crediti vs clienti',                 'assets', '40', false),
    (p_sector, '42',    'Crediti verso altri',                'assets', NULL, true),
    (p_sector, '42050', 'Erario c/IVA credito',              'assets', '42', false),
    (p_sector, '42056', 'Erario c/acconto IRES',             'assets', '42', false),
    (p_sector, '42058', 'Erario c/acconto IRAP',             'assets', '42', false),
    (p_sector, '42071', 'INAIL credito',                     'assets', '42', false),
    (p_sector, '42129', 'Altri crediti',                     'assets', '42', false),
    (p_sector, '43',    'Ratei e risconti attivi',            'assets', NULL, true),
    (p_sector, '43013', 'Risconti attivi',                   'assets', '43', false),
    (p_sector, '50',    'Disponibilità liquide',              'assets', NULL, true),
    (p_sector, '50000', 'Cassa contante',                    'assets', '50', false),
    (p_sector, '50100', 'Banca c/c principale',              'assets', '50', false),
    (p_sector, '50101', 'Banca c/c secondario',              'assets', '50', false),
    (p_sector, '50109', 'Carta di credito aziendale',        'assets', '50', false);

  -- ═══ PATRIMONIO NETTO (equity) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '10',    'Patrimonio netto',                  'equity', NULL, true),
    (p_sector, '10020', 'Capitale sociale',                  'equity', '10', false),
    (p_sector, '10300', 'Riserva legale',                    'equity', '10', false),
    (p_sector, '10600', 'Riserva straordinaria',             'equity', '10', false),
    (p_sector, '10710', 'Utili esercizi precedenti',         'equity', '10', false);

  -- ═══ PASSIVO PATRIMONIALE (liabilities) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '11',    'Fondi rischi e oneri',              'liabilities', NULL, true),
    (p_sector, '11011', 'Fondo TFR amministratori',          'liabilities', '11', false),
    (p_sector, '1128',  'Fondo svalutazione crediti',        'liabilities', '11', false),
    (p_sector, '12',    'TFR lavoro subordinato',            'liabilities', NULL, true),
    (p_sector, '12000', 'Fondo T.F.R.',                      'liabilities', '12', false),
    (p_sector, '21080', 'Fondi ammortamento immobilizzazioni','liabilities', NULL, false),
    (p_sector, '41',    'Fornitori',                         'liabilities', NULL, true),
    (p_sector, '41000', 'Debiti vs fornitori',               'liabilities', '41', false),
    (p_sector, '44',    'Debiti commerciali',                'liabilities', NULL, true),
    (p_sector, '44020', 'Fatture da ricevere',               'liabilities', '44', false),
    (p_sector, '44200', 'Anticipi da clienti',               'liabilities', '44', false),
    (p_sector, '45',    'Debiti tributari e previdenziali',   'liabilities', NULL, true),
    (p_sector, '45000', 'Ritenute fiscali lavoro dipendente','liabilities', '45', false),
    (p_sector, '45003', 'Ritenute fiscali lavoro autonomo',  'liabilities', '45', false),
    (p_sector, '45010', 'Addizionale regionale',             'liabilities', '45', false),
    (p_sector, '45011', 'Addizionale comunale',              'liabilities', '45', false),
    (p_sector, '45040', 'IVA conto Erario',                  'liabilities', '45', false),
    (p_sector, '45200', 'INPS',                              'liabilities', '45', false),
    (p_sector, '45420', 'Debiti vs dipendenti retribuzioni', 'liabilities', '45', false),
    (p_sector, '45541', 'Debiti vs amministratori',          'liabilities', '45', false),
    (p_sector, '46',    'Ratei e risconti passivi',          'liabilities', NULL, true),
    (p_sector, '46019', 'Risconti passivi',                  'liabilities', '46', false);

  -- ═══ COSTI DELLA PRODUZIONE (cost_production) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '60',     'Costi della produzione',            'cost_production', NULL, true),
    (p_sector, '60100',  'Acquisto merci',                    'cost_production', '60', false),
    (p_sector, '60300',  'Materiali di consumo',              'cost_production', '60', false),
    (p_sector, '60420',  'Acquisti di servizi',               'cost_production', '60', false),
    (p_sector, '60702',  'Spese di trasporto',                'cost_production', '60', false),
    (p_sector, '60710',  'Lavorazioni esterne',               'cost_production', '60', false),
    (p_sector, '60720',  'Manutenzione mezzi 100%',           'cost_production', '60', false),
    (p_sector, '607204', 'Manutenzione mezzi 20%',            'cost_production', '60', false),
    (p_sector, '60730',  'Consulenza amministrativa/fiscale', 'cost_production', '60', false),
    (p_sector, '60731',  'Consulenza del lavoro',             'cost_production', '60', false),
    (p_sector, '60732',  'Consulenze diverse',                'cost_production', '60', false),
    (p_sector, '607320', 'Consulenze tecniche',               'cost_production', '60', false),
    (p_sector, '6073201','Consulenze legali',                 'cost_production', '60', false),
    (p_sector, '60801',  'Carburanti e lubrificanti',         'cost_production', '60', false),
    (p_sector, '60812',  'Carburanti 100%',                   'cost_production', '60', false),
    (p_sector, '608124', 'Carburanti 20%',                    'cost_production', '60', false),
    (p_sector, '60821',  'Assicurazioni rischi',              'cost_production', '60', false),
    (p_sector, '60822',  'Assicurazioni automezzi 100%',      'cost_production', '60', false),
    (p_sector, '608224', 'Assicurazioni automezzi 20%',       'cost_production', '60', false),
    (p_sector, '60830',  'Energia elettrica',                 'cost_production', '60', false),
    (p_sector, '60831',  'Gas',                               'cost_production', '60', false),
    (p_sector, '60836',  'Acqua',                             'cost_production', '60', false),
    (p_sector, '60840',  'Cancelleria e stampati',            'cost_production', '60', false),
    (p_sector, '60850',  'Elaborazione dati',                 'cost_production', '60', false),
    (p_sector, '60852',  'Spese postali',                     'cost_production', '60', false),
    (p_sector, '608530', 'Spese telefoniche 80%',             'cost_production', '60', false),
    (p_sector, '60870',  'Abbonamenti e riviste',             'cost_production', '60', false),
    (p_sector, '60872',  'Smaltimento rifiuti',               'cost_production', '60', false),
    (p_sector, '60876',  'Software',                          'cost_production', '60', false),
    (p_sector, '608150', 'Ristorazione/pernottamenti 75%',    'cost_production', '60', false),
    (p_sector, '60890',  'Pubblicità e propaganda',           'cost_production', '60', false),
    (p_sector, '60892',  'Spese di rappresentanza',           'cost_production', '60', false),
    (p_sector, '60893',  'Omaggi',                            'cost_production', '60', false),
    (p_sector, '60901',  'Affitti e locazioni',               'cost_production', '60', false),
    (p_sector, '6093',   'Canoni leasing',                    'cost_production', '60', false);

  -- ═══ COSTI PER IL PERSONALE (cost_personnel) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '61',    'Costi per il personale',            'cost_personnel', NULL, true),
    (p_sector, '61000', 'Salari e stipendi',                 'cost_personnel', '61', false),
    (p_sector, '61100', 'Contributi INPS',                   'cost_personnel', '61', false),
    (p_sector, '61200', 'TFR',                               'cost_personnel', '61', false),
    (p_sector, '61402', 'Rimborsi trasferte',                'cost_personnel', '61', false);

  -- ═══ AMMORTAMENTI (depreciation) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '62',    'Ammortamenti e svalutazioni',       'depreciation', NULL, true),
    (p_sector, '62160', 'Ammortamento beni strumentali',     'depreciation', '62', false);

  -- ═══ ALTRI COSTI (other_costs) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '63',    'Altri costi della produzione',      'other_costs', NULL, true),
    (p_sector, '63203', 'Imposta di bollo',                  'other_costs', '63', false),
    (p_sector, '63207', 'Tassa possesso automezzi 100%',     'other_costs', '63', false),
    (p_sector, '632074','Tassa possesso automezzi 20%',      'other_costs', '63', false),
    (p_sector, '63209', 'Imposte e tasse diverse',           'other_costs', '63', false),
    (p_sector, '63270', 'Costi indeducibili',                'other_costs', '63', false),
    (p_sector, '63271', 'Multe e sanzioni',                  'other_costs', '63', false),
    (p_sector, '63290', 'Mensa aziendale',                   'other_costs', '63', false);

  -- ═══ INTERESSI E ONERI FINANZIARI (financial) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '64',    'Interessi e oneri finanziari',      'financial', NULL, true),
    (p_sector, '64000', 'Interessi passivi',                 'financial', '64', false),
    (p_sector, '64330', 'Spese bancarie',                    'financial', '64', false),
    (p_sector, '64333', 'Spese incasso Italia/estero',       'financial', '64', false);

  -- ═══ RICAVI (revenue) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '70',    'Valore della produzione',           'revenue', NULL, true),
    (p_sector, '70000', 'Ricavi vendite',                    'revenue', '70', false),
    (p_sector, '70005', 'Ricavi per prestazioni di servizi', 'revenue', '70', false);

  -- ═══ PROVENTI FINANZIARI (financial) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '72',    'Proventi finanziari',               'financial', NULL, true),
    (p_sector, '72031', 'Altri proventi finanziari',         'financial', '72', false);

  -- ═══ PROVENTI STRAORDINARI (extraordinary) ═══
  INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
    (p_sector, '74',    'Proventi straordinari',             'extraordinary', NULL, true),
    (p_sector, '74040', 'Plusvalenze da alienazioni',        'extraordinary', '74', false);

END;
$$ LANGUAGE plpgsql;

-- ─── Insert base for all 3 sectors ──────────────────────────

SELECT _tmp_insert_coa_base('commercio');
SELECT _tmp_insert_coa_base('servizi');
SELECT _tmp_insert_coa_base('manifattura_costruzioni');

-- ─── Sector-specific: COMMERCIO ─────────────────────────────

INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
  ('commercio', '60110', 'Acquisto merci per rivendita',      'cost_production', '60', false),
  ('commercio', '60111', 'Acquisto carburanti',               'cost_production', '60', false),
  ('commercio', '60412', 'Trasporto su acquisti',             'cost_production', '60', false),
  ('commercio', '60810', 'Trasporto su vendite',              'cost_production', '60', false),
  ('commercio', '60706', 'Servizi commerciali',               'cost_production', '60', false),
  ('commercio', '60414', 'Provvigioni passive su vendite',    'cost_production', '60', false),
  ('commercio', '31300', 'Rimanenze merci c/rivendita',       'assets',          '31', false),
  ('commercio', '70001', 'Vendita merci al dettaglio',        'revenue',         '70', false),
  ('commercio', '70002', 'Vendita merci all''ingrosso',       'revenue',         '70', false),
  ('commercio', '70010', 'Vendite online/e-commerce',         'revenue',         '70', false),
  ('commercio', '70020', 'Vendite con corrispettivi',         'revenue',         '70', false)
ON CONFLICT (sector, code) DO UPDATE SET name = EXCLUDED.name, section = EXCLUDED.section;

-- ─── Sector-specific: SERVIZI ───────────────────────────────

INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
  ('servizi', '60711',   'Collaborazioni esterne',           'cost_production', '60', false),
  ('servizi', '60882',   'Formazione e aggiornamento',       'cost_production', '60', false),
  ('servizi', '6042001', 'Servizi informatici',              'cost_production', '60', false),
  ('servizi', '6042004', 'Servizi di sicurezza',             'cost_production', '60', false),
  ('servizi', '70006',   'Ricavi per assistenza tecnica',    'revenue',         '70', false),
  ('servizi', '70007',   'Ricavi per progettazione',         'revenue',         '70', false),
  ('servizi', '70008',   'Ricavi per formazione',            'revenue',         '70', false),
  ('servizi', '70010',   'Ricavi abbonamenti/licenze',       'revenue',         '70', false)
ON CONFLICT (sector, code) DO UPDATE SET name = EXCLUDED.name, section = EXCLUDED.section;

-- For servizi, override base names for sector-specific meaning
UPDATE public.coa_templates SET name = 'Subappalto servizi' WHERE sector = 'servizi' AND code = '60710';
UPDATE public.coa_templates SET name = 'Ricavi per consulenze' WHERE sector = 'servizi' AND code = '70005';

-- ─── Sector-specific: MANIFATTURA/COSTRUZIONI ───────────────

INSERT INTO public.coa_templates (sector, code, name, section, parent_code, is_header) VALUES
  ('manifattura_costruzioni', '60111',   'Acquisto carburanti e lubrificanti', 'cost_production', '60', false),
  ('manifattura_costruzioni', '60310',   'Materiali per manutenzione',        'cost_production', '60', false),
  ('manifattura_costruzioni', '60412',   'Trasporto su acquisti',             'cost_production', '60', false),
  ('manifattura_costruzioni', '60414',   'Indumenti da lavoro',              'cost_production', '60', false),
  ('manifattura_costruzioni', '60726',   'Pezzi di ricambio',               'cost_production', '60', false),
  ('manifattura_costruzioni', '6072620', 'Pneumatici',                       'cost_production', '60', false),
  ('manifattura_costruzioni', '60810',   'Trasporto su vendite',             'cost_production', '60', false),
  ('manifattura_costruzioni', '60883',   'Pulizia esterna',                  'cost_production', '60', false),
  ('manifattura_costruzioni', '6090020', 'Locazione immobili produttivi',    'cost_production', '60', false),
  ('manifattura_costruzioni', '6090021', 'Noleggio macchinari',             'cost_production', '60', false),
  ('manifattura_costruzioni', '21107',   'Automezzi specifici/mezzi sollevamento', 'assets', '21', false),
  ('manifattura_costruzioni', '21121',   'Macchinari specifici',             'assets', '21', false),
  ('manifattura_costruzioni', '31110',   'Rimanenze semilavorati',           'assets', '31', false),
  ('manifattura_costruzioni', '70006',   'Ricavi da trasporto',              'revenue', '70', false),
  ('manifattura_costruzioni', '70007',   'Ricavi da noleggio macchinari',    'revenue', '70', false),
  ('manifattura_costruzioni', '70008',   'Ricavi da manutenzione',           'revenue', '70', false)
ON CONFLICT (sector, code) DO UPDATE SET name = EXCLUDED.name, section = EXCLUDED.section;

-- Override base names for sector-specific meaning
UPDATE public.coa_templates SET name = 'Acquisto materie prime' WHERE sector = 'manifattura_costruzioni' AND code = '60100';
UPDATE public.coa_templates SET name = 'Lavorazioni c/terzi' WHERE sector = 'manifattura_costruzioni' AND code = '60710';
UPDATE public.coa_templates SET name = 'Vendita prodotti' WHERE sector = 'manifattura_costruzioni' AND code = '70000';

-- ─── Cleanup temp function ──────────────────────────────────

DROP FUNCTION _tmp_insert_coa_base(text);
