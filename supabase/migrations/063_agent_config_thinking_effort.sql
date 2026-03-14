-- Migration 063: Add thinking_effort to agent_config

ALTER TABLE public.agent_config
  ADD COLUMN IF NOT EXISTS thinking_effort text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS thinking_effort_escalation text DEFAULT 'none';

COMMENT ON COLUMN public.agent_config.thinking_effort IS
  'Text-based reasoning effort for models like OpenAI o1/o3-mini (e.g. none, low, medium, high)';
