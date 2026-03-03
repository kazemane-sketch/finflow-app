-- =============================================
-- CHAT AI PERSISTENTE
-- =============================================

CREATE TABLE IF NOT EXISTS public.ai_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Nuova conversazione',
  summary text,
  message_count int NOT NULL DEFAULT 0,
  total_tokens int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_chats_select ON public.ai_chats FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = ai_chats.company_id AND cm.user_id = auth.uid()));
CREATE POLICY ai_chats_insert ON public.ai_chats FOR INSERT
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = ai_chats.company_id AND cm.user_id = auth.uid()));
CREATE POLICY ai_chats_update ON public.ai_chats FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY ai_chats_delete ON public.ai_chats FOR DELETE
  USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES public.ai_chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  tool_name text,
  tool_args jsonb,
  tool_result jsonb,
  tokens_used int DEFAULT 0,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_messages_select ON public.ai_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.ai_chats c WHERE c.id = ai_messages.chat_id AND c.user_id = auth.uid()));
CREATE POLICY ai_messages_insert ON public.ai_messages FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.ai_chats c WHERE c.id = ai_messages.chat_id AND c.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_ai_messages_chat_id ON public.ai_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_chats_company ON public.ai_chats(company_id, updated_at DESC);

-- =============================================
-- DATA SUMMARIES PRE-CALCOLATI
-- =============================================

CREATE TABLE IF NOT EXISTS public.ai_data_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  scope text NOT NULL,
  summary_text text NOT NULL,
  data_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, scope)
);

ALTER TABLE public.ai_data_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_data_summaries_select ON public.ai_data_summaries FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = ai_data_summaries.company_id AND cm.user_id = auth.uid()));

-- =============================================
-- SUGGERIMENTI RICONCILIAZIONE
-- =============================================

CREATE TABLE IF NOT EXISTS public.reconciliation_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  installment_id uuid REFERENCES public.invoice_installments(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  match_score numeric(5,2) NOT NULL,
  match_reason text NOT NULL,
  proposed_by text NOT NULL CHECK (proposed_by IN ('deterministic', 'rule', 'ai')),
  rule_id uuid,
  suggestion_data jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reconciliation_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_suggestions_all ON public.reconciliation_suggestions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = reconciliation_suggestions.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_recon_sugg_company_status
  ON public.reconciliation_suggestions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_recon_sugg_bank_tx
  ON public.reconciliation_suggestions(bank_transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_recon_sugg_installment
  ON public.reconciliation_suggestions(installment_id, status);
CREATE INDEX IF NOT EXISTS idx_recon_sugg_invoice
  ON public.reconciliation_suggestions(invoice_id, status);
CREATE INDEX IF NOT EXISTS idx_recon_sugg_score
  ON public.reconciliation_suggestions(company_id, match_score DESC)
  WHERE status = 'pending';

-- =============================================
-- REGOLE DI RICONCILIAZIONE APPRESE (feedback loop)
-- =============================================

CREATE TABLE IF NOT EXISTS public.reconciliation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_type text NOT NULL CHECK (rule_type IN ('exact_ref', 'counterparty_amount', 'mandate_pattern', 'learned', 'manual')),
  pattern jsonb NOT NULL,
  action jsonb NOT NULL,
  confidence numeric(5,4) NOT NULL DEFAULT 0.5000,
  hit_count int NOT NULL DEFAULT 0,
  reject_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reconciliation_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_rules_all ON public.reconciliation_rules FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = reconciliation_rules.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_reconciliation_rules_company
  ON public.reconciliation_rules(company_id, confidence DESC);

-- =============================================
-- LOG RICONCILIAZIONI (audit trail completo)
-- =============================================

CREATE TABLE IF NOT EXISTS public.reconciliation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  suggestion_id uuid REFERENCES public.reconciliation_suggestions(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES public.reconciliation_rules(id) ON DELETE SET NULL,
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  installment_id uuid REFERENCES public.invoice_installments(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  proposed_by text NOT NULL CHECK (proposed_by IN ('deterministic', 'rule', 'ai', 'manual')),
  accepted boolean NOT NULL,
  user_id uuid REFERENCES auth.users(id),
  match_score numeric(5,2),
  match_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reconciliation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY reconciliation_log_all ON public.reconciliation_log FOR ALL
  USING (EXISTS (SELECT 1 FROM public.company_members cm WHERE cm.company_id = reconciliation_log.company_id AND cm.user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_bank_tx ON public.reconciliation_log(bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_log_installment ON public.reconciliation_log(installment_id);
