-- Add phase_id column to classification_rules for phase-aware rule learning
ALTER TABLE public.classification_rules
  ADD COLUMN IF NOT EXISTS phase_id uuid REFERENCES public.article_phases(id) ON DELETE SET NULL;

-- Add phase_id column to article_assignment_rules for phase-aware article matching
ALTER TABLE public.article_assignment_rules
  ADD COLUMN IF NOT EXISTS phase_id uuid REFERENCES public.article_phases(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.classification_rules.phase_id IS 'Article phase learned from user confirmation, used in fast-path suggestions';
COMMENT ON COLUMN public.article_assignment_rules.phase_id IS 'Article phase learned from user confirmation';
