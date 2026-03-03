-- Make bank_ai_search_candidates PostgREST-friendly by accepting text vector input.
-- PostgREST can fail to resolve extension types in RPC args; we cast text -> vector inside SQL.

DROP FUNCTION IF EXISTS public.bank_ai_search_candidates(uuid, vector(3072), int, text, date, date);
DROP FUNCTION IF EXISTS public.bank_ai_search_candidates(uuid, text, int, text, date, date);

CREATE OR REPLACE FUNCTION public.bank_ai_search_candidates(
  p_company_id uuid,
  p_query_vector text,
  p_limit int DEFAULT 50,
  p_direction text DEFAULT 'all',
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  date date,
  value_date date,
  amount numeric(15,2),
  description text,
  counterparty_name text,
  transaction_type text,
  reference text,
  invoice_ref text,
  direction text,
  similarity numeric
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_direction text := case when lower(coalesce(p_direction, 'all')) in ('in', 'out', 'all') then lower(p_direction) else 'all' end;
  v_query_vector vector(3072);
BEGIN
  IF NOT public.bank_embedding_has_company_access(p_company_id) THEN
    RAISE EXCEPTION 'Permesso negato su azienda %', p_company_id USING errcode = '42501';
  END IF;

  IF p_query_vector IS NULL OR length(trim(p_query_vector)) = 0 THEN
    RAISE EXCEPTION 'Query vector mancante' USING errcode = '22023';
  END IF;

  BEGIN
    v_query_vector := p_query_vector::vector(3072);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Query vector invalido: %', SQLERRM USING errcode = '22P02';
  END;

  RETURN QUERY
  SELECT
    bt.id,
    bt.date,
    bt.value_date,
    bt.amount,
    bt.description,
    bt.counterparty_name,
    bt.transaction_type,
    bt.reference,
    bt.invoice_ref,
    bt.direction,
    (bt.embedding <=> v_query_vector)::numeric AS similarity
  FROM public.bank_transactions bt
  WHERE bt.company_id = p_company_id
    AND bt.embedding IS NOT NULL
    AND bt.embedding_status = 'ready'
    AND (v_direction = 'all' OR bt.direction = v_direction)
    AND (p_date_from IS NULL OR bt.date >= p_date_from)
    AND (p_date_to IS NULL OR bt.date <= p_date_to)
  ORDER BY bt.embedding <=> v_query_vector, bt.date DESC, bt.id
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.bank_ai_search_candidates(uuid, text, int, text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bank_ai_search_candidates(uuid, text, int, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_ai_search_candidates(uuid, text, int, text, date, date) TO service_role;

DO $$
BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;
