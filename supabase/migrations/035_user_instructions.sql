-- 035: User Instructions — persistent AI memory for classification & reconciliation rules
-- Users can save instructions via AI chat or manually in ContropartiPage / ImpostazioniPage.
-- These instructions are fed as context to classify-invoice-lines and ai-chat.

CREATE TABLE IF NOT EXISTS public.user_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Scope determines where the instruction applies
  scope text NOT NULL DEFAULT 'general'
    CHECK (scope IN ('general','counterparty','category','classification','reconciliation')),
  scope_ref uuid,  -- optional: counterparty_id, category_id, etc.

  instruction text NOT NULL,

  -- How the instruction was created
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','ai_chat')),
  source_message_id uuid REFERENCES public.ai_messages(id) ON DELETE SET NULL,

  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_instructions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_instructions_all ON public.user_instructions FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = user_instructions.company_id AND cm.user_id = auth.uid()
  ));

-- Fast lookup: active instructions by company + scope
CREATE INDEX IF NOT EXISTS idx_ui_company_scope
  ON public.user_instructions(company_id, scope)
  WHERE active = true;

-- Fast lookup: instructions for a specific entity (counterparty, category)
CREATE INDEX IF NOT EXISTS idx_ui_scope_ref
  ON public.user_instructions(scope_ref)
  WHERE active = true AND scope_ref IS NOT NULL;
