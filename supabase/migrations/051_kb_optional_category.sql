-- 051: Make category nullable on kb_documents
-- The AI classification fills category automatically, so it should not be required on insert.
-- source_type CHECK already allows NULL; category CHECK does not — fix it.

ALTER TABLE public.kb_documents DROP CONSTRAINT IF EXISTS kb_documents_category_check;
ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_category_check
  CHECK (category IS NULL OR category IN (
    'normativa_fiscale', 'principi_contabili', 'principi_revisione',
    'prassi_interpretativa', 'normativa_periodica', 'giurisprudenza',
    'tabelle_operative', 'normativa_lavoro', 'normativa_societaria'
  ));
