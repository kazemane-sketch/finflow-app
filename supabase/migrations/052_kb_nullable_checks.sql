-- 052: Fix CHECK constraints on optional kb_documents columns
-- All taxonomy/metadata fields must accept NULL so the user can create
-- a document with just title + text, letting the AI fill the rest.

-- authority (optional — AI fills it)
ALTER TABLE public.kb_documents DROP CONSTRAINT IF EXISTS kb_documents_authority_check;
ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_authority_check
  CHECK (authority IS NULL OR authority IN (
    'tuir', 'dpr_633', 'dpr_600', 'codice_civile',
    'oic', 'isa_italia', 'agenzia_entrate', 'mef',
    'cassazione', 'corte_costituzionale', 'commissione_tributaria',
    'cndcec', 'eu', 'altro'
  ));

-- update_frequency (optional — AI fills it, no 'static' default)
ALTER TABLE public.kb_documents DROP CONSTRAINT IF EXISTS kb_documents_update_frequency_check;
ALTER TABLE public.kb_documents ADD CONSTRAINT kb_documents_update_frequency_check
  CHECK (update_frequency IS NULL OR update_frequency IN (
    'static', 'annual', 'periodic', 'volatile'
  ));
