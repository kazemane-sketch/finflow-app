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

/* ─── extraction prompt ────────────────────── */

function buildPrompt(inv: InvoiceRow): string {
  return `Sei un analizzatore di fatture elettroniche italiane (FatturaPA). Estrai un riassunto strutturato completo.

INFORMAZIONI DA ESTRARRE:
- Articoli/servizi: nome prodotto/servizio, quantità, prezzo unitario, aliquota IVA. Se descrizioni lunghe, riassumi mantenendo keyword chiave.
- Importi: imponibile, IVA, totale, sconti/maggiorazioni, bollo
- Controparte: denominazione, P.IVA, codice fiscale, indirizzo/sede, PEC se nel XML
- Condizioni pagamento: modalità (bonifico/SDD/RIBA/etc.), giorni (30/60/90), IBAN beneficiario, banca appoggio — cerca in CondizioniPagamento > ModalitaPagamento (MP01=contanti, MP05=bonifico, MP08=carta, MP12=RIBA, MP19=SEPA DD)
- Riferimenti: numero ordine, CIG, CUP, codice commessa, numero contratto, riferimento DDT — cerca in DatiOrdineAcquisto, DatiContratto, AltriDatiGestionali
- Scadenze: date e importi per rata, stato pagamento
- Tipo documento: TD01 (fattura), TD04 (nota credito), TD24 (differita), etc.
- Keywords: lista parole chiave per ricerca (nomi prodotti, servizi, marchi, codici)

Rispondi SOLO con un JSON valido, senza markdown, senza backtick.

Dati fattura:
Numero: ${inv.number}
Data: ${inv.date}
Tipo: ${inv.doc_type}
Direzione: ${inv.direction}
Totale: ${inv.total_amount} | Imponibile: ${inv.taxable_amount} | IVA: ${inv.vat_amount}
Controparte: ${JSON.stringify(inv.counterparty)}
Righe: ${JSON.stringify(inv.lines)}
Rate: ${JSON.stringify(inv.installments)}
XML (primi 3000 caratteri): ${clip(inv.raw_xml, 3000) || "Non disponibile"}`;
}

/* ─── types ─────────────────────────────────── */

interface InvoiceRow {
  id: string;
  number: string;
  date: string;
  total_amount: number;
  taxable_amount: number;
  vat_amount: number;
  doc_type: string;
  direction: string;
  counterparty: Record<string, unknown> | null;
  raw_xml: string | null;
  lines: Array<Record<string, unknown>> | null;
  installments: Array<Record<string, unknown>> | null;
}

/* ─── Anthropic API call ──────────────────── */

async function extractSummary(
  apiKey: string,
  inv: InvoiceRow,
): Promise<Record<string, unknown>> {
  const prompt = buildPrompt(inv);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 2048,
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
    // 1. Select pending invoices with lines and installments
    const rows: InvoiceRow[] = await sql.unsafe(
      `SELECT i.id, i.number, i.date, i.total_amount, i.taxable_amount,
              COALESCE(i.tax_amount, i.vat_amount, 0) as vat_amount,
              i.doc_type, i.direction, i.counterparty, i.raw_xml,
              (SELECT json_agg(json_build_object(
                'line_number', il.line_number, 'description', il.description,
                'quantity', il.quantity, 'unit_price', il.unit_price,
                'total_price', il.total_price, 'vat_rate', il.vat_rate
              ) ORDER BY il.line_number) FROM invoice_lines il WHERE il.invoice_id = i.id) as lines,
              (SELECT json_agg(json_build_object(
                'due_date', inst.due_date, 'amount_due', inst.amount_due,
                'paid_amount', inst.paid_amount, 'status', inst.status,
                'installment_no', inst.installment_no
              ) ORDER BY inst.due_date) FROM invoice_installments inst WHERE inst.invoice_id = i.id) as installments
       FROM invoices i
       WHERE i.company_id = $1
         AND i.extraction_status = 'pending'
       ORDER BY i.date DESC
       LIMIT $2`,
      [companyId, batchSize],
    );

    if (rows.length === 0) {
      const [{ cnt }] = await sql.unsafe(
        `SELECT count(*)::int AS cnt FROM invoices
         WHERE company_id = $1 AND extraction_status = 'pending'`,
        [companyId],
      );
      return json({ processed: 0, ready: 0, errors: 0, total_pending: cnt });
    }

    // 2. Mark as processing
    const ids = rows.map((r) => r.id);
    await sql.unsafe(
      `UPDATE invoices SET extraction_status = 'processing' WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    // 3. Process with concurrency
    let ready = 0;
    let errors = 0;

    await runWithConcurrency(rows, CONCURRENCY, async (inv) => {
      try {
        const summary = await extractSummary(anthropicKey, inv);

        await sql.unsafe(
          `UPDATE invoices
           SET extracted_summary = $1::jsonb,
               extraction_status = 'ready',
               extraction_model = $2,
               extracted_at = now()
           WHERE id = $3`,
          [JSON.stringify(summary), HAIKU_MODEL, inv.id],
        );
        ready += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[invoice-extract-summary] Error for invoice ${inv.id}:`, msg);

        await sql.unsafe(
          `UPDATE invoices
           SET extraction_status = 'error',
               extraction_model = $1,
               extracted_summary = $2::jsonb,
               extracted_at = now()
           WHERE id = $3`,
          [HAIKU_MODEL, JSON.stringify({ error: clip(msg, 500) }), inv.id],
        ).catch(() => {});
        errors += 1;
      }
    });

    // 4. Count remaining pending
    const [{ cnt: totalPending }] = await sql.unsafe(
      `SELECT count(*)::int AS cnt FROM invoices
       WHERE company_id = $1 AND extraction_status = 'pending'`,
      [companyId],
    );

    return json({
      processed: rows.length,
      ready,
      errors,
      total_pending: totalPending,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[invoice-extract-summary] Fatal:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
