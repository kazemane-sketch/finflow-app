import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 5;
const MAX_BATCH = 50;

/* ─── helpers ──────────────────────────────── */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

const EXTRACTION_PROMPT = `Sei un parser bancario italiano. Dato il testo raw di un'operazione bancaria, estrai TUTTI i riferimenti strutturati.

REGOLE:
- Cerca numeri di fattura (patterns: "FATT.", "FT-", "FT.", "/FE/", "N.", "NR.", "FATTURA", numeri con formato XXX/YY, XXX/YYYY)
- Cerca codici mandato SDD (pattern: "MANDATO" seguito da codice alfanumerico lungo)
- Cerca numeri SDD/RID (pattern: "SDD N." o "ADDEBITO DIRETTO" seguito da numero)
- Cerca riferimenti interni (pattern: codici alfanumerici di 10+ caratteri, codici con mix lettere/numeri)
- Cerca BIC/SWIFT (pattern: 8 o 11 caratteri alfanumerici tipo "UNCRITMMXXX")
- Cerca IBAN
- Cerca CRO/TRN (pattern: numeri di 30+ cifre dopo "CRO" o "TRN")
- Cerca causali bancarie (pattern: "CAUS:" o "CAUSALE" seguito da codice)
- Cerca numeri contratto leasing (pattern: "CONTRATTO" o "CONTR." seguito da codice)
- Cerca numeri rata mutuo (pattern: "RATA" seguito da numero)
- Cerca importo netto vs lordo vs commissioni se presenti separati nel testo
- Cerca qualsiasi altro codice identificativo univoco

Rispondi SOLO con un JSON valido, senza markdown, senza backtick. Se un campo non è presente, usa null. Array vuoti per liste senza risultati.

Testo operazione:
"""
{RAW_TEXT}
"""`;

type TxRow = {
  id: string;
  raw_text: string;
  description: string | null;
  counterparty_name: string | null;
  amount: number;
  date: string | null;
  transaction_type: string | null;
};

/* ─── Anthropic API call ──────────────────── */

async function extractRefs(
  apiKey: string,
  rawText: string,
): Promise<Record<string, unknown>> {
  const prompt = EXTRACTION_PROMPT.replace("{RAW_TEXT}", clip(rawText, 2000));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown");
    throw new Error(`Anthropic API ${response.status}: ${clip(err, 200)}`);
  }

  const data = await response.json();
  let text =
    data?.content?.[0]?.type === "text" ? data.content[0].text : "";

  // Strip markdown code fences if Haiku wraps them
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  return JSON.parse(text);
}

/* ─── concurrency runner ──────────────────── */

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (idx < items.length) {
        const current = items[idx];
        idx += 1;
        await worker(current);
      }
    },
  );
  await Promise.all(runners);
}

/* ─── main handler ────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();

  if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY non configurata" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: { company_id?: string; batch_size?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const batchSize = Math.min(Math.max(body.batch_size ?? 50, 1), MAX_BATCH);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // 1. Select pending rows
    const rows: TxRow[] = await sql`
      SELECT id, raw_text, description, counterparty_name, amount, date, transaction_type
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND extraction_status = 'pending'
        AND raw_text IS NOT NULL
        AND raw_text != ''
      ORDER BY date DESC
      LIMIT ${batchSize}
    `;

    if (rows.length === 0) {
      // Count total pending (including those with null raw_text)
      const [{ cnt }] = await sql`
        SELECT count(*)::int AS cnt FROM bank_transactions
        WHERE company_id = ${companyId} AND extraction_status = 'pending'
      `;
      return json({ processed: 0, ready: 0, errors: 0, total_pending: cnt });
    }

    // 2. Mark as processing
    const ids = rows.map((r) => r.id);
    await sql`
      UPDATE bank_transactions
      SET extraction_status = 'processing'
      WHERE id = ANY(${ids})
    `;

    // 3. Process with concurrency
    let ready = 0;
    let errors = 0;

    await runWithConcurrency(rows, CONCURRENCY, async (row) => {
      try {
        const refs = await extractRefs(anthropicKey, row.raw_text);

        await sql`
          UPDATE bank_transactions
          SET extracted_refs = ${JSON.stringify(refs)}::jsonb,
              extraction_status = 'ready',
              extraction_model = ${HAIKU_MODEL},
              extracted_at = now()
          WHERE id = ${row.id}
        `;
        ready += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extract-refs] Error for tx ${row.id}:`, msg);

        await sql`
          UPDATE bank_transactions
          SET extraction_status = 'error',
              extraction_model = ${HAIKU_MODEL},
              extracted_refs = ${JSON.stringify({ error: clip(msg, 500) })}::jsonb,
              extracted_at = now()
          WHERE id = ${row.id}
        `.catch(() => {});
        errors += 1;
      }
    });

    // 4. Also skip rows with no raw_text (mark as 'skipped')
    await sql`
      UPDATE bank_transactions
      SET extraction_status = 'skipped'
      WHERE company_id = ${companyId}
        AND extraction_status = 'pending'
        AND (raw_text IS NULL OR raw_text = '')
    `;

    // 5. Count remaining pending
    const [{ cnt: totalPending }] = await sql`
      SELECT count(*)::int AS cnt FROM bank_transactions
      WHERE company_id = ${companyId} AND extraction_status = 'pending'
    `;

    return json({
      processed: rows.length,
      ready,
      errors,
      total_pending: totalPending,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bank-extract-refs] Fatal:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
