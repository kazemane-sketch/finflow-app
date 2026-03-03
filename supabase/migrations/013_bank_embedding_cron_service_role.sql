-- Background embeddings pipeline (service_role + pg_cron)

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_net not available: %', SQLERRM;
END
$$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available: %', SQLERRM;
END
$$;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.runtime_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE private.runtime_secrets FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bank_embedding_claim_batch()
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
SECURITY DEFINER
SET search_path = public
AS $$
  WITH batch AS (
    SELECT bt.id
    FROM public.bank_transactions bt
    WHERE bt.embedding_status = 'pending'
    ORDER BY bt.embedding_updated_at NULLS FIRST, bt.date DESC, bt.id
    FOR UPDATE SKIP LOCKED
    LIMIT 200
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

REVOKE ALL ON FUNCTION public.bank_embedding_claim_batch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_embedding_claim_batch() TO service_role;

CREATE OR REPLACE FUNCTION private.bank_embed_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_service_role_key text;
  v_headers jsonb;
  v_url text := 'https://xtuofcwvimaffcpqboou.supabase.co/functions/v1/bank-embed-transactions';
BEGIN
  SELECT rs.value
  INTO v_service_role_key
  FROM private.runtime_secrets rs
  WHERE rs.name = 'SUPABASE_SERVICE_ROLE_KEY';

  IF v_service_role_key IS NULL OR length(trim(v_service_role_key)) = 0 THEN
    RAISE NOTICE 'bank_embed_cron_tick skipped: SUPABASE_SERVICE_ROLE_KEY missing in private.runtime_secrets';
    RETURN;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', v_service_role_key,
    'Authorization', 'Bearer ' || v_service_role_key
  );

  PERFORM net.http_post(
    url := v_url,
    headers := v_headers,
    body := jsonb_build_object('source', 'pg_cron')
  );
END;
$$;

REVOKE ALL ON FUNCTION private.bank_embed_cron_tick() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed: skipping scheduler creation';
    RETURN;
  END IF;

  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'bank_embed_every_5m';
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule(
    'bank_embed_every_5m',
    '*/5 * * * *',
    'select private.bank_embed_cron_tick();'
  );
END
$$;

-- One-time setup after migration:
-- INSERT INTO private.runtime_secrets(name, value)
-- VALUES ('SUPABASE_SERVICE_ROLE_KEY', '<YOUR_SERVICE_ROLE_KEY>')
-- ON CONFLICT (name)
-- DO UPDATE SET value = EXCLUDED.value, updated_at = now();
