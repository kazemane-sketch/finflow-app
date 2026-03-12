-- Migration 053: Add thinking_budget column + expand agent_type CHECK + insert kb_classifier
-- thinking_budget provides direct numeric control over Gemini thinking tokens.
-- It OVERRIDES the text-based thinking_level when set.

-- 1. Add thinking_budget column
ALTER TABLE public.agent_config
  ADD COLUMN IF NOT EXISTS thinking_budget int DEFAULT NULL;

COMMENT ON COLUMN public.agent_config.thinking_budget IS
  'Explicit thinking token budget (0=off, 1024-32768). Overrides thinking_level when set.';

-- 2. Expand agent_type CHECK to include kb_classifier
ALTER TABLE public.agent_config
  DROP CONSTRAINT IF EXISTS agent_config_agent_type_check;
ALTER TABLE public.agent_config
  ADD CONSTRAINT agent_config_agent_type_check
    CHECK (agent_type IN ('commercialista', 'revisore', 'kb_classifier'));

-- 3. Update existing agents: switch to gemini-2.5-pro, set explicit thinking_budget
UPDATE public.agent_config
SET model = 'gemini-2.5-pro',
    thinking_budget = 4096,
    thinking_level = 'medium'
WHERE agent_type = 'commercialista';

UPDATE public.agent_config
SET model = 'gemini-2.5-pro',
    thinking_budget = 16384,
    thinking_level = 'high'
WHERE agent_type = 'revisore';

-- 4. Insert kb_classifier if not exists
INSERT INTO public.agent_config (
  agent_type, display_name, description,
  system_prompt, model, thinking_level, thinking_budget,
  temperature, max_output_tokens
) VALUES (
  'kb_classifier',
  'Classificatore Documenti KB',
  'Analizza e classifica documenti normativi nella Knowledge Base',
  'Sei un esperto di normativa fiscale e contabile italiana. Analizza il documento fornito e compila i metadati di classificazione.',
  'gemini-2.5-pro',
  'medium',
  8192,
  0.1,
  8192
) ON CONFLICT (agent_type) DO UPDATE SET
  model = EXCLUDED.model,
  thinking_budget = EXCLUDED.thinking_budget;

-- 5. Update MODELS list in the select: add gemini-3-flash-preview
-- (No DB change needed, this is just a UI constant)
