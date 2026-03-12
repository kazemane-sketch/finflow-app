-- 056: Materialized view account_balances + fiscal_budgets + pnl_summary
-- Bilancio aggregato in tempo reale

-- Materialized view: saldi per conto, mese, anno
CREATE MATERIALIZED VIEW IF NOT EXISTS public.account_balances AS
SELECT
  i.company_id,
  il.account_id,
  coa.code AS account_code,
  coa.name AS account_name,
  coa.section AS account_section,
  EXTRACT(YEAR FROM i.date)::int AS fiscal_year,
  EXTRACT(MONTH FROM i.date)::int AS fiscal_month,
  SUM(CASE WHEN i.direction = 'in' THEN il.total_price ELSE 0 END) AS total_dare,
  SUM(CASE WHEN i.direction = 'out' THEN il.total_price ELSE 0 END) AS total_avere,
  SUM(il.total_price) AS total_amount,
  COUNT(il.id)::int AS line_count,
  MAX(i.updated_at) AS last_updated
FROM public.invoice_lines il
JOIN public.invoices i ON i.id = il.invoice_id
LEFT JOIN public.chart_of_accounts coa ON coa.id = il.account_id
WHERE il.account_id IS NOT NULL
  AND il.line_action = 'classify'
  AND il.classification_status IN ('confirmed', 'manual')
GROUP BY i.company_id, il.account_id, coa.code, coa.name, coa.section,
         EXTRACT(YEAR FROM i.date), EXTRACT(MONTH FROM i.date);

CREATE UNIQUE INDEX idx_account_balances_pk
  ON public.account_balances(company_id, account_id, fiscal_year, fiscal_month);
CREATE INDEX idx_account_balances_company_year
  ON public.account_balances(company_id, fiscal_year);
CREATE INDEX idx_account_balances_section
  ON public.account_balances(account_section);

-- RPC per refreshare la materialized view (CONCURRENTLY = no lock su letture)
CREATE OR REPLACE FUNCTION public.refresh_account_balances()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.account_balances;
END;
$$;

-- Tabella budget fiscali (soglie annuali per categoria di spesa)
CREATE TABLE IF NOT EXISTS public.fiscal_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_year int NOT NULL,
  budget_type text NOT NULL CHECK (budget_type IN (
    'rappresentanza',
    'veicoli_non_strumentali',
    'telefonia',
    'vitto_alloggio',
    'omaggi',
    'spese_non_inerenti',
    'altro'
  )),
  budget_limit numeric(15,2),
  consumed numeric(15,2) DEFAULT 0,
  budget_pct numeric(5,2),
  notes text,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company_id, fiscal_year, budget_type)
);

ALTER TABLE public.fiscal_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fiscal_budgets_company" ON public.fiscal_budgets
  FOR ALL USING (company_id IN (
    SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
  ));

-- Vista P&L aggregata per anno/mese
CREATE OR REPLACE VIEW public.pnl_summary AS
SELECT
  company_id,
  fiscal_year,
  fiscal_month,
  SUM(CASE WHEN account_section = 'revenue' THEN total_avere ELSE 0 END) AS ricavi,
  SUM(CASE WHEN account_section = 'cost_production' THEN total_dare ELSE 0 END) AS costi_produzione,
  SUM(CASE WHEN account_section = 'cost_personnel' THEN total_dare ELSE 0 END) AS costi_personale,
  SUM(CASE WHEN account_section = 'depreciation' THEN total_dare ELSE 0 END) AS ammortamenti,
  SUM(CASE WHEN account_section = 'other_costs' THEN total_dare ELSE 0 END) AS altri_costi,
  SUM(CASE WHEN account_section = 'financial' THEN total_avere - total_dare ELSE 0 END) AS saldo_finanziario,
  SUM(CASE WHEN account_section = 'extraordinary' THEN total_avere - total_dare ELSE 0 END) AS saldo_straordinario,
  SUM(line_count) AS total_lines
FROM public.account_balances
GROUP BY company_id, fiscal_year, fiscal_month;

-- Refresh iniziale
SELECT public.refresh_account_balances();
