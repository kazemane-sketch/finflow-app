-- Migration 025: Categories, Projects, Chart of Accounts + Invoice Classifications
-- Adds three classification systems: categories (user-defined tags), projects/commesse,
-- and chart of accounts (piano dei conti). Each can be assigned at invoice level (madre)
-- or line level (riga), with line-level overriding invoice-level.

-- =============================================
-- CATEGORIE (create dall'utente, con colore)
-- =============================================

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('revenue', 'expense', 'both')),
  color text NOT NULL DEFAULT '#6366f1',
  icon text,
  description text,
  parent_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  sort_order int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, name)
);

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY categories_all ON public.categories FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = categories.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- PROGETTI / COMMESSE (cave, cantieri, etc.)
-- =============================================

CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  color text NOT NULL DEFAULT '#10b981',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'suspended')),
  start_date date,
  end_date date,
  budget numeric,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, code)
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_all ON public.projects FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = projects.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- PIANO DEI CONTI
-- =============================================

CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  section text NOT NULL CHECK (section IN (
    'assets', 'liabilities', 'equity', 'revenue',
    'cost_production', 'cost_personnel', 'depreciation',
    'other_costs', 'financial', 'extraordinary'
  )),
  parent_code text,
  level int NOT NULL DEFAULT 1,
  is_header boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, code)
);

ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY chart_of_accounts_all ON public.chart_of_accounts FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = chart_of_accounts.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_coa_company ON public.chart_of_accounts(company_id, section, code);

-- =============================================
-- ASSEGNAZIONI A LIVELLO FATTURA (madre)
-- =============================================

CREATE TABLE IF NOT EXISTS public.invoice_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  assigned_by text NOT NULL DEFAULT 'manual' CHECK (assigned_by IN ('manual', 'ai_auto', 'ai_confirmed')),
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id)
);

ALTER TABLE public.invoice_classifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_classifications_all ON public.invoice_classifications FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = invoice_classifications.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- ASSEGNAZIONE PROGETTI A FATTURA (con percentuale)
-- =============================================

CREATE TABLE IF NOT EXISTS public.invoice_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  percentage numeric(5,2) NOT NULL DEFAULT 100.00,
  assigned_by text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_id, project_id)
);

ALTER TABLE public.invoice_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_projects_all ON public.invoice_projects FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = invoice_projects.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- ASSEGNAZIONI A LIVELLO RIGA/ARTICOLO
-- =============================================

ALTER TABLE public.invoice_line_articles
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL;

ALTER TABLE public.invoice_line_articles
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.invoice_line_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES public.invoice_lines(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  percentage numeric(5,2) NOT NULL DEFAULT 100.00,
  assigned_by text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invoice_line_id, project_id)
);

ALTER TABLE public.invoice_line_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_line_projects_all ON public.invoice_line_projects FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = invoice_line_projects.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- SEED: Piano dei conti CAVECO
-- =============================================

INSERT INTO public.chart_of_accounts (company_id, code, name, section, level, is_header, sort_order) VALUES
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70', 'Valore della produzione', 'revenue', 1, true, 100),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70000', 'Vendita pozzolana e materiale generico', 'revenue', 2, false, 101),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70002', 'Vendite calcare frantumato', 'revenue', 2, false, 102),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70003', 'Vendite minerale di calcare', 'revenue', 2, false, 103),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70004', 'Vendita materiale da estrazione', 'revenue', 2, false, 104),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70005', 'Ricavi per prestazioni di servizi', 'revenue', 2, false, 105),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70006', 'Ricavi da trasporto', 'revenue', 2, false, 106),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70007', 'Ricavi da noleggio', 'revenue', 2, false, 107),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70008', 'Ricavi da manutenzione mezzi', 'revenue', 2, false, 108),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '70009', 'Ricavi da Scopertura Cave', 'revenue', 2, false, 109),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7000930', 'Ricavi per locazione', 'revenue', 3, false, 110),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7000940', 'Ricavi per cessione di rottami', 'revenue', 3, false, 111),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7050001', 'Contributo Sabatini', 'revenue', 2, false, 112),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7053020', 'Contributo Carbon tax', 'revenue', 2, false, 113),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7053024', 'Contributo Gasolio Autotrasportatori', 'revenue', 2, false, 114),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7054220', 'Credito Imposta Beni Strumentali', 'revenue', 2, false, 115),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '7063001', 'Rimborso spese esplosivo', 'revenue', 2, false, 116),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60', 'Costi della produzione', 'cost_production', 1, true, 200),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60100', 'Acquisto di merci e prodotti', 'cost_production', 2, false, 201),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60111', 'Acquisto carburanti e lubrificanti', 'cost_production', 2, false, 202),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60300', 'Materiale di consumo', 'cost_production', 2, false, 203),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60310', 'Materiali per manutenzione', 'cost_production', 2, false, 204),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60412', 'Trasporti su acquisti', 'cost_production', 2, false, 205),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60420', 'Acquisti di servizi', 'cost_production', 2, false, 206),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60702', 'Spese di Trasporto', 'cost_production', 2, false, 207),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60710', 'Prestazioni da terzi/Lavorazioni esterne', 'cost_production', 2, false, 208),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60720', 'Manutenzione automezzi 100%', 'cost_production', 2, false, 209),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60722', 'Manutenzione immobili/impianti', 'cost_production', 2, false, 210),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60726', 'Pezzi di ricambio', 'cost_production', 2, false, 211),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60730', 'Consulenza amministrativa/fiscale', 'cost_production', 2, false, 212),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60731', 'Consulenza del lavoro', 'cost_production', 2, false, 213),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60732', 'Consulenze diverse', 'cost_production', 2, false, 214),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60810', 'Trasporti per vendite', 'cost_production', 2, false, 215),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60812', 'Carburanti e lubrificanti 100%', 'cost_production', 2, false, 216),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60822', 'Assicurazioni automezzi', 'cost_production', 2, false, 217),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60830', 'Energia elettrica', 'cost_production', 2, false, 218),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60850', 'Elaborazione dati esterni', 'cost_production', 2, false, 219),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60859', 'Spese amministrative diverse', 'cost_production', 2, false, 220),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60872', 'Smaltimento rifiuti', 'cost_production', 2, false, 221),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60890', 'Pubblicita e propaganda', 'cost_production', 2, false, 222),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '6090020', 'Locazione Cava', 'cost_production', 2, false, 223),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '6090021', 'Noleggio Automezzi/Macchinari', 'cost_production', 2, false, 224),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '60901', 'Affitto beni di terzi', 'cost_production', 2, false, 225),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '6093', 'Canoni Leasing', 'cost_production', 2, true, 226),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '61', 'Costi per il personale', 'cost_personnel', 1, true, 300),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '61000', 'Salari e stipendi', 'cost_personnel', 2, false, 301),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '61100', 'Contributi INPS', 'cost_personnel', 2, false, 302),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '61200', 'TFR', 'cost_personnel', 2, false, 303),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '61402', 'Rimborsi trasferte', 'cost_personnel', 2, false, 304),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '62', 'Ammortamenti e svalutazioni', 'depreciation', 1, true, 400),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '62160', 'Ammortamento beni strumentali', 'depreciation', 2, false, 401),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '63', 'Altri costi della produzione', 'other_costs', 1, true, 500),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '63207', 'Tassa possesso automezzi', 'other_costs', 2, false, 501),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '63290', 'Mensa aziendale', 'other_costs', 2, false, 502),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '64', 'Interessi e oneri finanziari', 'financial', 1, true, 600),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '64000', 'Interessi passivi', 'financial', 2, false, 601),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '64330', 'Spese bancarie', 'financial', 2, false, 602),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '72', 'Proventi finanziari', 'financial', 1, true, 700),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '72031', 'Altri proventi', 'financial', 2, false, 701),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', '72102', 'Interessi attivi BTP', 'financial', 2, false, 702)
ON CONFLICT (company_id, code) DO NOTHING;

-- =============================================
-- SEED: Progetti CAVECO
-- =============================================

INSERT INTO public.projects (company_id, code, name, color, status) VALUES
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'SERLE', 'Cava Serle (BS)', '#10b981', 'active'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'PAITONE', 'Cava Paitone (BS)', '#3b82f6', 'active'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUIDONIA', 'Stabilimento Guidonia (RM)', '#f59e0b', 'active'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'PONTE-LUC', 'Cava Ponte Lucano, Tivoli (RM)', '#8b5cf6', 'active'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'FORMELL', 'Cava Formelluccia', '#ef4444', 'active'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'COLLEGR', 'Cava Collegrosso, Guidonia (RM)', '#ec4899', 'active')
ON CONFLICT (company_id, code) DO NOTHING;

-- =============================================
-- SEED: Categorie CAVECO
-- =============================================

INSERT INTO public.categories (company_id, name, type, color) VALUES
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Vendita calcare', 'revenue', '#10b981'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Vendita pietrisco', 'revenue', '#059669'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Trasporto', 'revenue', '#3b82f6'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Servizi cava', 'revenue', '#8b5cf6'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Noleggio', 'revenue', '#6366f1'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Carburante', 'expense', '#ef4444'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Manutenzione mezzi', 'expense', '#f59e0b'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Leasing', 'expense', '#f97316'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Personale', 'expense', '#ec4899'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Energia', 'expense', '#eab308'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Consulenze', 'expense', '#64748b'),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'Assicurazioni', 'expense', '#94a3b8')
ON CONFLICT (company_id, name) DO NOTHING;
