-- 058: Invoice decision trail vNext + consultant sidecar
-- Adds:
-- - consultant agent configuration support
-- - summary-first KB fields
-- - per-line audit trail tables for commercialista / revisore / final decision
-- - consultant resolutions table
-- - denormalized final decision fields on invoice_lines

-- ============================================================
-- 1. AGENT CONFIG: add consultant + deep-mode thinking budget
-- ============================================================
ALTER TABLE public.agent_config
  ADD COLUMN IF NOT EXISTS thinking_budget_escalation int DEFAULT NULL;

COMMENT ON COLUMN public.agent_config.thinking_budget_escalation IS
  'Optional deep-mode thinking budget used by agents that support a second runtime profile.';

ALTER TABLE public.agent_config
  DROP CONSTRAINT IF EXISTS agent_config_agent_type_check;

ALTER TABLE public.agent_config
  ADD CONSTRAINT agent_config_agent_type_check
    CHECK (agent_type IN ('commercialista', 'revisore', 'consulente', 'kb_classifier'));

INSERT INTO public.agent_config (
  agent_type,
  display_name,
  description,
  system_prompt,
  model,
  model_escalation,
  temperature,
  thinking_level,
  thinking_budget,
  thinking_budget_escalation,
  max_output_tokens,
  active
) VALUES (
  'consulente',
  'Consulente AI',
  'Advisor fiscale e contabile contestuale, con visione aziendale aggregata',
  'Sei un consulente fiscale e contabile italiano senior. Non sei un classificatore cieco: ragioni con prudenza professionale, espliciti rischi e alternative, citi le evidenze usate, e non suggerisci mai scorciatoie elusive o aggressive. Quando l''evidenza non basta, dichiari il dubbio e chiedi chiarimenti oppure proponi un esito conservativo.',
  'gemini-2.5-pro',
  'gemini-2.5-pro',
  0.1,
  'high',
  8192,
  24576,
  32768,
  true
)
ON CONFLICT (agent_type) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  thinking_budget_escalation = COALESCE(public.agent_config.thinking_budget_escalation, EXCLUDED.thinking_budget_escalation);

-- ============================================================
-- 2. KNOWLEDGE BASE: summary-first fields for retrieval
-- ============================================================
ALTER TABLE public.knowledge_base
  ADD COLUMN IF NOT EXISTS summary_structured jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_chunk_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.knowledge_base.summary_structured IS
  'Structured summary used as the primary retrieval unit instead of terse hard rules.';
COMMENT ON COLUMN public.knowledge_base.applicability IS
  'Applicability metadata for filtering by company/operation context.';
COMMENT ON COLUMN public.knowledge_base.source_chunk_ids IS
  'Original kb_chunks that support this knowledge item.';

CREATE INDEX IF NOT EXISTS idx_kb_summary_structured
  ON public.knowledge_base USING gin (summary_structured);
CREATE INDEX IF NOT EXISTS idx_kb_applicability
  ON public.knowledge_base USING gin (applicability);

-- ============================================================
-- 3. INVOICE LINES: denormalized final-decision snapshot
-- ============================================================
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS decision_status text
    CHECK (decision_status IN ('pending', 'finalized', 'needs_review', 'unassigned')),
  ADD COLUMN IF NOT EXISTS reasoning_summary_final text,
  ADD COLUMN IF NOT EXISTS final_confidence int,
  ADD COLUMN IF NOT EXISTS final_decision_source text
    CHECK (final_decision_source IN ('commercialista', 'revisore', 'consulente', 'user', 'exact_match', 'none'));

COMMENT ON COLUMN public.invoice_lines.decision_status IS
  'Final operational status for the line: finalized, needs_review, unassigned or pending.';
COMMENT ON COLUMN public.invoice_lines.reasoning_summary_final IS
  'Single final reasoning summary shown in the operational UI.';
COMMENT ON COLUMN public.invoice_lines.final_confidence IS
  'Final confidence after reviewer/consultant consolidation.';
COMMENT ON COLUMN public.invoice_lines.final_decision_source IS
  'Who produced the currently applied decision snapshot.';

CREATE INDEX IF NOT EXISTS idx_invoice_lines_decision_status
  ON public.invoice_lines(decision_status);

-- ============================================================
-- 4. AUDIT TABLES: commercialista / revisore / final decision
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invoice_line_commercialista_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES public.invoice_lines(id) ON DELETE CASCADE,
  proposal jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence int,
  rationale_summary text,
  decision_basis text[] NOT NULL DEFAULT '{}',
  supporting_factors text[] NOT NULL DEFAULT '{}',
  supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_line_reviewer_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES public.invoice_lines(id) ON DELETE CASCADE,
  verdict jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_status text
    CHECK (decision_status IN ('pending', 'finalized', 'needs_review', 'unassigned')),
  final_confidence int,
  rationale_summary text,
  decision_basis text[] NOT NULL DEFAULT '{}',
  supporting_factors text[] NOT NULL DEFAULT '{}',
  supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  red_flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_line_final_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES public.invoice_lines(id) ON DELETE CASCADE,
  decision_source text NOT NULL
    CHECK (decision_source IN ('commercialista', 'revisore', 'consulente', 'user', 'exact_match', 'none')),
  decision_status text
    CHECK (decision_status IN ('pending', 'finalized', 'needs_review', 'unassigned')),
  applied_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence int,
  rationale_summary text,
  decision_basis text[] NOT NULL DEFAULT '{}',
  supporting_factors text[] NOT NULL DEFAULT '{}',
  supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_consultant_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_line_ids uuid[] NOT NULL DEFAULT '{}',
  resolution_status text NOT NULL DEFAULT 'proposed'
    CHECK (resolution_status IN ('proposed', 'applied', 'dismissed')),
  message_excerpt text,
  recommended_conclusion text,
  rationale_summary text,
  risk_level text
    CHECK (risk_level IN ('low', 'medium', 'high')),
  supporting_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_impact text,
  decision_patch jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  dismissed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ilcp_invoice_line
  ON public.invoice_line_commercialista_proposals(invoice_line_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ilrv_invoice_line
  ON public.invoice_line_reviewer_verdicts(invoice_line_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ilfd_invoice_line
  ON public.invoice_line_final_decisions(invoice_line_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_icr_invoice
  ON public.invoice_consultant_resolutions(invoice_id, created_at DESC);

ALTER TABLE public.invoice_line_commercialista_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_reviewer_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_final_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_consultant_resolutions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoice_line_commercialista_proposals'
      AND policyname = 'ilcp_all'
  ) THEN
    CREATE POLICY "ilcp_all" ON public.invoice_line_commercialista_proposals
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoice_line_reviewer_verdicts'
      AND policyname = 'ilrv_all'
  ) THEN
    CREATE POLICY "ilrv_all" ON public.invoice_line_reviewer_verdicts
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoice_line_final_decisions'
      AND policyname = 'ilfd_all'
  ) THEN
    CREATE POLICY "ilfd_all" ON public.invoice_line_final_decisions
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'invoice_consultant_resolutions'
      AND policyname = 'icr_all'
  ) THEN
    CREATE POLICY "icr_all" ON public.invoice_consultant_resolutions
      FOR ALL USING (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.invoices i
          WHERE i.id = invoice_id AND public.is_company_member(i.company_id)
        )
      );
  END IF;
END $$;
