-- Force POST path for claim RPC by requiring one argument.

DROP FUNCTION IF EXISTS public.bank_embedding_claim_batch();

CREATE OR REPLACE FUNCTION public.bank_embedding_claim_batch(
  p_batch_size integer DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  date date,
  value_date date,
  amount numeric,
  description text,
  counterparty_name text,
  transaction_type text,
  reference text,
  invoice_ref text,
  direction text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH batch AS (
    SELECT bt.id
    FROM public.bank_transactions bt
    WHERE bt.embedding_status = 'pending'
    ORDER BY bt.embedding_updated_at NULLS FIRST, bt.date DESC, bt.id
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(coalesce(p_batch_size, 200), 1)
  ),
  claimed AS (
    UPDATE public.bank_transactions bt
    SET embedding_status = 'processing',
        embedding_error = NULL,
        embedding_updated_at = now()
    FROM batch b
    WHERE bt.id = b.id
    RETURNING
      bt.id,
      bt.company_id,
      bt.date,
      bt.value_date,
      bt.amount,
      bt.description,
      bt.counterparty_name,
      bt.transaction_type,
      bt.reference,
      bt.invoice_ref,
      bt.direction::text
  )
  SELECT * FROM claimed;
$$;

REVOKE ALL ON FUNCTION public.bank_embedding_claim_batch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_embedding_claim_batch(integer) TO service_role;
