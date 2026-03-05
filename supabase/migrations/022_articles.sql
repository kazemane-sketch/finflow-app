-- =============================================
-- TABELLA ARTICOLI
-- =============================================

CREATE TABLE IF NOT EXISTS public.articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  unit text NOT NULL DEFAULT 't',
  category text,
  direction text,
  active boolean NOT NULL DEFAULT true,
  keywords text[] DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, code)
);

ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY articles_all ON public.articles FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = articles.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_articles_company ON public.articles(company_id);

-- =============================================
-- COLLEGAMENTO RIGA FATTURA → ARTICOLO
-- =============================================

CREATE TABLE IF NOT EXISTS public.invoice_line_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES public.invoice_lines(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,

  quantity numeric,
  unit_price numeric,
  total_price numeric,
  vat_rate numeric,

  assigned_by text NOT NULL DEFAULT 'manual' CHECK (assigned_by IN ('manual', 'ai_auto', 'ai_confirmed')),
  confidence numeric(5,2),
  verified boolean NOT NULL DEFAULT false,

  location text,
  period_from date,
  period_to date,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(invoice_line_id)
);

ALTER TABLE public.invoice_line_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_line_articles_all ON public.invoice_line_articles FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = invoice_line_articles.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_ila_article ON public.invoice_line_articles(article_id, company_id);
CREATE INDEX IF NOT EXISTS idx_ila_invoice ON public.invoice_line_articles(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ila_company_verified ON public.invoice_line_articles(company_id, verified);

-- =============================================
-- REGOLE APPRESE PER ASSEGNAZIONE ARTICOLI
-- =============================================

CREATE TABLE IF NOT EXISTS public.article_assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE CASCADE,

  pattern jsonb NOT NULL,

  confidence numeric(5,4) NOT NULL DEFAULT 0.6000,
  hit_count int NOT NULL DEFAULT 0,
  reject_count int NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'learned' CHECK (source IN ('manual', 'learned')),
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.article_assignment_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY article_assignment_rules_all ON public.article_assignment_rules FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = article_assignment_rules.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_aar_company ON public.article_assignment_rules(company_id, confidence DESC);

-- =============================================
-- SEED ARTICOLI CAVECO
-- =============================================

INSERT INTO public.articles (company_id, code, name, unit, category, direction, keywords) VALUES
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'CAL-070', 'Calcare Frantumato 0-70 mm', 't', 'Fornitura calcare', 'both', ARRAY['calcare', 'frantumato', '0-70', '070']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'PIE-030', 'Pietrisco di Calcare 0-30 mm', 't', 'Fornitura calcare', 'both', ARRAY['pietrisco', 'calcare', '0-30', '030']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'TRA-TRV', 'Trasporto Travertino', 't', 'Trasporto', 'in', ARRAY['trasporto', 'travertino', 'cumulo', 'frantoio']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'TRA-COL', 'Trasporto Calcare Collegrosso', 't', 'Trasporto', 'in', ARRAY['calcare', 'collegrosso', 'trasporto']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'COL-ARG', 'Coltivazione Argilla', 't', 'Coltivazione', 'in', ARRAY['coltivazione', 'argilla', 'formelluccia']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'FRE-POZ', 'Fresatura Pozzolana Nera', 't', 'Lavorazione', 'in', ARRAY['fresatura', 'pozzolana', 'nera']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'SCO-POZ', 'Scopertura Pozzolanica', 't', 'Lavorazione', 'in', ARRAY['scopertura', 'pozzolanico', 'tufo']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'SRV-ESP', 'Rimborso Esplosivo', 'forfait', 'Servizi', 'in', ARRAY['esplosivo', 'rimborso']),
('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'SRV-RIP', 'Ripristino Ambientale', 'forfait', 'Servizi', 'in', ARRAY['ripristino', 'ambientale', 'scarpata'])
ON CONFLICT (company_id, code) DO NOTHING;
