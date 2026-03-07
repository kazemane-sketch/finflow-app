-- 032_classification_rules.sql
-- Deterministic fast-path rules learned from user confirmations.
-- Each time a user confirms a classification, a rule is created/updated.
-- Next time a similar invoice line appears, the system suggests instantly (0ms vs 3-5s AI).

CREATE TABLE IF NOT EXISTS public.classification_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Matching criteria
  counterparty_vat_key text,
  counterparty_name_pattern text,
  description_pattern text NOT NULL,
  direction text CHECK (direction IN ('in','out')),

  -- Suggested classification output
  article_id uuid,
  category_id uuid,
  account_id uuid,
  cost_center_allocations jsonb,

  -- Metadata
  confidence numeric(5,2) DEFAULT 95,
  times_applied int DEFAULT 0,
  times_confirmed int DEFAULT 1,
  times_corrected int DEFAULT 0,
  source text DEFAULT 'user_confirm' CHECK (source IN ('user_confirm','user_manual','ai_learned','instruction')),
  active boolean DEFAULT true,
  last_applied_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Fast lookup by counterparty vat_key + direction
CREATE INDEX IF NOT EXISTS idx_rules_lookup
  ON public.classification_rules (company_id, counterparty_vat_key, direction)
  WHERE counterparty_vat_key IS NOT NULL AND active = true;

-- Fallback lookup by name pattern when no vat_key
CREATE INDEX IF NOT EXISTS idx_rules_name_lookup
  ON public.classification_rules (company_id, direction)
  WHERE counterparty_name_pattern IS NOT NULL AND active = true;

-- Prevent duplicate rules for same counterparty + description pattern
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique
  ON public.classification_rules (company_id, counterparty_vat_key, description_pattern, direction)
  WHERE counterparty_vat_key IS NOT NULL;

-- RLS
ALTER TABLE public.classification_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "classification_rules_company_access" ON public.classification_rules
  FOR ALL
  USING (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()))
  WITH CHECK (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()));
