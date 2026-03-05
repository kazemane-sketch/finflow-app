-- Migration 027: Cost Centers Hierarchy + AI Classification Fields
-- Adds parent_id for 2-level hierarchy, amount for allocations, AI fields for suggestions

-- ═══════════════════════════════════════════════════════════
-- 1. DDL: parent_id on projects (self-referencing hierarchy)
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_parent
  ON public.projects(company_id, parent_id);

-- ═══════════════════════════════════════════════════════════
-- 2. DDL: amount on invoice_projects and invoice_line_projects
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.invoice_projects
  ADD COLUMN IF NOT EXISTS amount numeric;

ALTER TABLE public.invoice_line_projects
  ADD COLUMN IF NOT EXISTS amount numeric;

-- ═══════════════════════════════════════════════════════════
-- 3. DDL: AI confidence/reasoning on invoice_classifications
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.invoice_classifications
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(5,2);

ALTER TABLE public.invoice_classifications
  ADD COLUMN IF NOT EXISTS ai_reasoning text;

ALTER TABLE public.invoice_projects
  ADD COLUMN IF NOT EXISTS ai_confidence numeric(5,2);

-- ═══════════════════════════════════════════════════════════
-- 4. Delete old flat projects (all have 0 assignments)
-- ═══════════════════════════════════════════════════════════

DELETE FROM public.projects
WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe'
  AND code IN ('SERLE','PAITONE','GUIDONIA','PONTE-LUC','FORMELL','COLLEGR','CASAL-BERTONE','ROMA-NORD');

-- ═══════════════════════════════════════════════════════════
-- 5. Insert Level 1: parent cost centers
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.projects (company_id, code, name, color, status, sort_order, parent_id, description) VALUES
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'BRE', 'Brescia Operations', '#10b981', 'active', 10, NULL, 'Area Brescia — cave a Serle, Paitone, Nuvolera'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI', 'Guidonia Operations', '#f59e0b', 'active', 20, NULL, 'Area Guidonia/Lazio — calcare, pozzolana, argilla'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'SEDE', 'Corporate Roma', '#94a3b8', 'active', 30, NULL, 'Sede amministrativa Roma'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'CANT', 'Cantieri', '#3b82f6', 'active', 40, NULL, 'Cantieri edili vari')
ON CONFLICT (company_id, code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- 6. Insert Level 2: child cost centers (under BRE)
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.projects (company_id, code, name, color, status, sort_order, parent_id, description) VALUES
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'BRE-CAV', 'Brescia Cava (estrazione calcare)', '#10b981', 'active', 11,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'BRE'),
    'Cave Serle, Paitone, Nuvolera — calcare per cementeria Buzzi Unicem Vernasca/Piacenza'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'BRE-ACQ', 'Brescia Acquisti (materiale da terzi)', '#059669', 'active', 12,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'BRE'),
    NULL),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'BRE-TRA', 'Brescia Trasporto (a Piacenza)', '#3b82f6', 'active', 13,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'BRE'),
    'Trasporto calcare da cave BS a cementeria Buzzi Vernasca/Piacenza'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'BRE-SED', 'Brescia Sede (costi indiretti)', '#94a3b8', 'active', 14,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'BRE'),
    NULL)
ON CONFLICT (company_id, code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- 7. Insert Level 2: child cost centers (under GUI)
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.projects (company_id, code, name, color, status, sort_order, parent_id, description) VALUES
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI-CAL', 'Guidonia Calcare (Collegrosso)', '#f59e0b', 'active', 21,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'GUI'),
    'Cava Collegrosso, Villa Adriana — calcare per cementeria Buzzi Guidonia'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI-POZ', 'Guidonia Pozzolana (Ponte Lucano)', '#8b5cf6', 'active', 22,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'GUI'),
    'Cava Ponte Lucano, Tivoli — pozzolana'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI-ARG', 'Guidonia Argilla (Formelluccia)', '#ef4444', 'active', 23,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'GUI'),
    'Cava Formelluccia — argilla'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI-TRA', 'Guidonia Trasporto (servizi interni)', '#6366f1', 'active', 24,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'GUI'),
    NULL),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'GUI-SED', 'Guidonia Sede (costi indiretti)', '#94a3b8', 'active', 25,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'GUI'),
    NULL)
ON CONFLICT (company_id, code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- 8. Insert Level 2: child cost centers (under CANT)
-- ═══════════════════════════════════════════════════════════

INSERT INTO public.projects (company_id, code, name, color, status, sort_order, parent_id, description) VALUES
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'CANT-CAPR', 'Cantiere Via Capranica Prenestina', '#3b82f6', 'active', 41,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'CANT'),
    'Costruzione villini Via Capranica Prenestina'),
  ('9f215045-578a-4c9d-af92-ca7cb9da01fe', 'CANT-MAZZ', 'Cantiere Capannone Mazzano Romano', '#60a5fa', 'active', 42,
    (SELECT id FROM public.projects WHERE company_id = '9f215045-578a-4c9d-af92-ca7cb9da01fe' AND code = 'CANT'),
    'Capannone Mazzano Romano')
ON CONFLICT (company_id, code) DO NOTHING;
