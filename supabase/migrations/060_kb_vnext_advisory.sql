-- 060: KB vNext - consultive notes instead of runtime rules

ALTER TABLE public.knowledge_base
  ADD COLUMN IF NOT EXISTS knowledge_kind text;

UPDATE public.knowledge_base
SET knowledge_kind = 'legacy_rule'
WHERE knowledge_kind IS NULL;

ALTER TABLE public.knowledge_base
  ALTER COLUMN knowledge_kind SET DEFAULT 'advisory_note';

ALTER TABLE public.knowledge_base
  ALTER COLUMN knowledge_kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_base_knowledge_kind_check'
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD CONSTRAINT knowledge_base_knowledge_kind_check
      CHECK (knowledge_kind IN ('advisory_note', 'numeric_fact', 'legacy_rule'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_knowledge_base_knowledge_kind
  ON public.knowledge_base (knowledge_kind);
