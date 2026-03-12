-- Migration 055: Informational line detection + KB chunks search
-- line_action: classify (default, backward-compatible), skip (informational), group (associated to parent)
-- grouped_with_line_id: FK to the parent classify line
-- skip_reason: AI-generated Italian description of why this line was skipped/grouped

-- 1. Add informational line columns
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS line_action text DEFAULT 'classify'
    CHECK (line_action IN ('classify', 'skip', 'group')),
  ADD COLUMN IF NOT EXISTS grouped_with_line_id uuid REFERENCES public.invoice_lines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS skip_reason text;

COMMENT ON COLUMN public.invoice_lines.line_action IS 'classify=riga contabile normale, skip=riga informativa da ignorare, group=raggruppata con altra riga';
COMMENT ON COLUMN public.invoice_lines.grouped_with_line_id IS 'Se line_action=group, ID della riga contabile a cui è associata';
COMMENT ON COLUMN public.invoice_lines.skip_reason IS 'Motivazione AI: es. Riferimento DDT, Riga vuota, Nota trasporto';

CREATE INDEX IF NOT EXISTS idx_invoice_lines_action ON public.invoice_lines(line_action);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_grouped ON public.invoice_lines(grouped_with_line_id) WHERE grouped_with_line_id IS NOT NULL;

-- 2. match_kb_chunks RPC for semantic search on KB documents
CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  query_embedding halfvec(3072),
  match_threshold float DEFAULT 0.40,
  match_count int DEFAULT 5,
  filter_company_id uuid DEFAULT NULL,
  filter_ateco text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  content text,
  document_title text,
  legal_reference text,
  section_title text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id,
    c.content,
    d.title AS document_title,
    d.legal_reference,
    c.section_title,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.kb_chunks c
  JOIN public.kb_documents d ON d.id = c.document_id
  WHERE d.active = true
    AND d.status = 'ready'
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
    -- Company filter: include if matches or is a global doc (null company_id)
    AND (
      filter_company_id IS NULL
      OR d.company_id IS NULL
      OR d.company_id = filter_company_id
    )
    -- ATECO filter: include if matches or document applies to all
    AND (
      filter_ateco IS NULL
      OR d.applies_to_ateco_prefixes IS NULL
      OR d.applies_to_ateco_prefixes && ARRAY[filter_ateco]
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
