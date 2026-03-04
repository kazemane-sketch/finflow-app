import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SONNET_MODEL = "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 5;
const MAX_CHAT_HISTORY = 20;

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

function parseJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/* ─── tool definitions ────────────────────── */

const tools = [
  {
    name: "get_invoices",
    description:
      "Cerca fatture dell'azienda con filtri opzionali. Ritorna: number, date, total_amount, direction, doc_type, counterparty, status.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ricerca parziale ILIKE)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        direction: { type: "string", enum: ["in", "out"], description: "in = attive (vendita), out = passive (acquisto)" },
        doc_type: { type: "string", description: "Tipo documento FatturaPA: TD01, TD04, TD24, etc." },
        number_contains: { type: "string", description: "Ricerca parziale nel numero fattura" },
        limit: { type: "number", description: "Max risultati (default 20, max 100)" },
      },
    },
  },
  {
    name: "get_invoice_detail",
    description: "Dettaglio completo di una singola fattura: righe, importi, rate associate.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoice_id: { type: "string", description: "UUID della fattura" },
      },
      required: ["invoice_id"],
    },
  },
  {
    name: "get_bank_transactions",
    description:
      "Cerca movimenti bancari. Include raw_text completo e riferimenti estratti (extracted_refs). Usa search_text per cercare nel testo operazione.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ILIKE)" },
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
        direction: { type: "string", enum: ["in", "out"] },
        transaction_type: { type: "string", description: "Tipo operazione (es. SDD/RID, Bonifico, F24...)" },
        amount_min: { type: "number" },
        amount_max: { type: "number" },
        search_text: { type: "string", description: "Ricerca ILIKE nel raw_text — per codici mandato, fatture, contratti" },
        reconciliation_status: { type: "string", enum: ["unmatched", "matched", "excluded"] },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
  },
  {
    name: "get_transaction_detail",
    description: "Dettaglio completo di un singolo movimento bancario con raw_text integrale e extracted_refs.",
    input_schema: {
      type: "object" as const,
      properties: {
        transaction_id: { type: "string", description: "UUID del movimento" },
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "get_open_installments",
    description:
      "Rate fatture aperte, scadute o parzialmente pagate. Utile per trovare cosa deve essere ancora pagato/incassato.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ILIKE)" },
        direction: { type: "string", enum: ["in", "out"], description: "in = incassi attesi, out = pagamenti da fare" },
        status: { type: "string", enum: ["pending", "overdue", "partial"], description: "Stato rata" },
        due_date_from: { type: "string" },
        due_date_to: { type: "string" },
        limit: { type: "number", description: "Default 30, max 100" },
      },
    },
  },
  {
    name: "search_raw_text",
    description:
      "Ricerca testuale full-text nei movimenti bancari (campo raw_text). Usa per cercare codici specifici: mandati, riferimenti fattura, contratti, IBAN, BIC.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Testo da cercare (supporta parole multiple, ciascuna cercata con ILIKE)" },
        limit: { type: "number", description: "Default 20, max 100" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_counterparties",
    description: "Lista controparti dell'azienda con statistiche aggregate.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Ricerca nel nome (ILIKE)" },
        limit: { type: "number", description: "Default 20" },
      },
    },
  },
  {
    name: "get_company_stats",
    description:
      "KPI generali: n. fatture attive/passive, n. movimenti, totale scaduto, totale da incassare, totale da pagare, saldo banca.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "suggest_reconciliation",
    description:
      "Propone match tra un movimento bancario e una o più fatture/rate. Analizza extracted_refs, controparte, importo, date.",
    input_schema: {
      type: "object" as const,
      properties: {
        bank_transaction_id: { type: "string", description: "UUID del movimento da riconciliare" },
      },
      required: ["bank_transaction_id"],
    },
  },
  {
    name: "search_knowledge_base",
    description:
      "Cerca nella knowledge base aziendale (documenti caricati dall'utente: PDF, TXT, CSV). Usa ricerca semantica con embeddings. Utile per trovare informazioni in documenti interni, contratti, regolamenti, procedure.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Domanda o testo da cercare nei documenti" },
        limit: { type: "number", description: "Numero max di risultati (default 5, max 20)" },
      },
      required: ["query"],
    },
  },
];

/* ─── tool handlers ───────────────────────── */

// deno-lint-ignore no-explicit-any
type SqlClient = ReturnType<typeof postgres>;

async function handleGetInvoices(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`i.counterparty->>'denom' ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.date_from) {
    conditions.push(`i.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`i.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }
  if (args.direction) {
    conditions.push(`i.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.doc_type) {
    conditions.push(`i.doc_type = $${idx}`);
    params.push(args.doc_type); idx++;
  }
  if (args.number_contains) {
    conditions.push(`i.number ILIKE '%' || $${idx} || '%'`);
    params.push(args.number_contains); idx++;
  }

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT i.id, i.number, i.date, i.total_amount, i.taxable_amount, i.tax_amount,
            i.direction, i.doc_type, i.counterparty->>'denom' as counterparty_name,
            i.counterparty->>'piva' as counterparty_vat,
            i.payment_status, i.reconciliation_status, i.source_filename
     FROM invoices i
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.date DESC
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetInvoiceDetail(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const [invoice] = await sql.unsafe(
    `SELECT i.*, i.counterparty->>'denom' as counterparty_name,
            i.counterparty->>'piva' as counterparty_vat,
            i.counterparty->>'cf' as counterparty_cf
     FROM invoices i
     WHERE i.id = $1 AND i.company_id = $2`,
    [args.invoice_id, companyId],
  );
  if (!invoice) return { error: "Fattura non trovata" };

  const lines = await sql.unsafe(
    `SELECT line_number, description, quantity, unit_price, total_price, vat_rate, vat_nature
     FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_number`,
    [args.invoice_id],
  );

  const installments = await sql.unsafe(
    `SELECT id, installment_no, installment_total, due_date, amount_due, paid_amount, status
     FROM invoice_installments WHERE invoice_id = $1 ORDER BY installment_no`,
    [args.invoice_id],
  );

  // Remove raw_xml to keep response small
  const { raw_xml: _xml, ...invoiceClean } = invoice;
  return { invoice: invoiceClean, lines, installments };
}

async function handleGetBankTransactions(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["bt.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`bt.counterparty_name ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.date_from) {
    conditions.push(`bt.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`bt.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }
  if (args.direction === "in") {
    conditions.push(`bt.amount > 0`);
  } else if (args.direction === "out") {
    conditions.push(`bt.amount < 0`);
  }
  if (args.transaction_type) {
    conditions.push(`bt.transaction_type ILIKE '%' || $${idx} || '%'`);
    params.push(args.transaction_type); idx++;
  }
  if (typeof args.amount_min === "number") {
    conditions.push(`abs(bt.amount) >= $${idx}`);
    params.push(args.amount_min); idx++;
  }
  if (typeof args.amount_max === "number") {
    conditions.push(`abs(bt.amount) <= $${idx}`);
    params.push(args.amount_max); idx++;
  }
  if (args.search_text) {
    const words = String(args.search_text).trim().split(/\s+/).filter((w: string) => w.length >= 2);
    for (const word of words) {
      conditions.push(`bt.raw_text ILIKE '%' || $${idx} || '%'`);
      params.push(word); idx++;
    }
  }
  if (args.reconciliation_status) {
    conditions.push(`bt.reconciliation_status = $${idx}`);
    params.push(args.reconciliation_status); idx++;
  }

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT bt.id, bt.date, bt.value_date, bt.amount, bt.description, bt.counterparty_name,
            bt.transaction_type, bt.reference, bt.invoice_ref, bt.direction, bt.raw_text,
            bt.extracted_refs, bt.reconciliation_status
     FROM bank_transactions bt
     WHERE ${conditions.join(" AND ")}
     ORDER BY bt.date DESC
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetTransactionDetail(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const [tx] = await sql.unsafe(
    `SELECT * FROM bank_transactions WHERE id = $1 AND company_id = $2`,
    [args.transaction_id, companyId],
  );
  if (!tx) return { error: "Movimento non trovato" };
  const { embedding: _emb, ...txClean } = tx;
  return txClean;
}

async function handleGetOpenInstallments(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["ii.company_id = $1", "ii.status IN ('pending', 'overdue', 'partial')"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`cp.name ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.direction) {
    conditions.push(`ii.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.status) {
    // Override the default IN clause
    conditions[1] = `ii.status = $${idx}`;
    params.push(args.status); idx++;
  }
  if (args.due_date_from) {
    conditions.push(`ii.due_date >= $${idx}::date`);
    params.push(args.due_date_from); idx++;
  }
  if (args.due_date_to) {
    conditions.push(`ii.due_date <= $${idx}::date`);
    params.push(args.due_date_to); idx++;
  }

  const limit = Math.min(Number(args.limit) || 30, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT ii.id, ii.invoice_id, ii.direction, ii.installment_no, ii.installment_total,
            ii.due_date, ii.amount_due, ii.paid_amount, ii.status,
            inv.number as invoice_number, inv.date as invoice_date,
            inv.counterparty->>'denom' as counterparty_name
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     LEFT JOIN counterparties cp ON cp.id = ii.counterparty_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ii.due_date ASC
     LIMIT $${idx}`,
    params,
  );
}

async function handleSearchRawText(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const queryText = String(args.query || "").trim();
  if (!queryText) return [];

  const words = queryText.split(/\s+/).filter((w: string) => w.length >= 2);
  const conditions = ["bt.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  for (const word of words) {
    conditions.push(`bt.raw_text ILIKE '%' || $${idx} || '%'`);
    params.push(word); idx++;
  }

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT bt.id, bt.date, bt.amount, bt.description, bt.counterparty_name,
            bt.transaction_type, bt.raw_text, bt.extracted_refs, bt.reconciliation_status
     FROM bank_transactions bt
     WHERE ${conditions.join(" AND ")}
     ORDER BY bt.date DESC
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetCounterparties(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["cp.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.search) {
    conditions.push(`cp.name ILIKE '%' || $${idx} || '%'`);
    params.push(args.search); idx++;
  }

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT cp.id, cp.name, cp.vat_number, cp.fiscal_code, cp.type,
            (SELECT count(*) FROM invoices i WHERE i.counterparty_id = cp.id AND i.direction = 'in') as fatture_attive,
            (SELECT count(*) FROM invoices i WHERE i.counterparty_id = cp.id AND i.direction = 'out') as fatture_passive,
            (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments ii WHERE ii.counterparty_id = cp.id AND ii.direction = 'out' AND ii.status IN ('pending','overdue','partial')) as debito_residuo,
            (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments ii WHERE ii.counterparty_id = cp.id AND ii.direction = 'in' AND ii.status IN ('pending','overdue','partial')) as credito_residuo
     FROM counterparties cp
     WHERE ${conditions.join(" AND ")}
     ORDER BY cp.name
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetCompanyStats(sql: SqlClient, companyId: string) {
  const [stats] = await sql.unsafe(
    `SELECT
      (SELECT count(*) FROM invoices WHERE company_id = $1 AND direction = 'in') as fatture_attive,
      (SELECT count(*) FROM invoices WHERE company_id = $1 AND direction = 'out') as fatture_passive,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1) as movimenti_totali,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND direction = 'out' AND status IN ('pending', 'overdue', 'partial')) as totale_da_pagare,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND direction = 'in' AND status IN ('pending', 'overdue', 'partial')) as totale_da_incassare,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND status = 'overdue') as totale_scaduto,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1 AND reconciliation_status = 'unmatched') as movimenti_non_riconciliati`,
    [companyId],
  );
  return stats;
}

async function handleSuggestReconciliation(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const [tx] = await sql.unsafe(
    `SELECT id, date, amount, counterparty_name, transaction_type, raw_text, extracted_refs, direction
     FROM bank_transactions WHERE id = $1 AND company_id = $2`,
    [args.bank_transaction_id, companyId],
  );
  if (!tx) return { error: "Movimento non trovato" };

  const suggestions: Array<Record<string, unknown>> = [];
  const absAmount = Math.abs(Number(tx.amount));
  const refs = tx.extracted_refs || {};

  // 1. Match by invoice_refs from extracted_refs
  if (refs.invoice_refs && Array.isArray(refs.invoice_refs) && refs.invoice_refs.length > 0) {
    for (const ref of refs.invoice_refs) {
      const matches = await sql.unsafe(
        `SELECT i.id as invoice_id, i.number, i.date, i.total_amount, i.direction,
                i.counterparty->>'denom' as counterparty_name,
                ii.id as installment_id, ii.due_date, ii.amount_due, ii.paid_amount, ii.status,
                ii.installment_no, ii.installment_total
         FROM invoices i
         LEFT JOIN invoice_installments ii ON ii.invoice_id = i.id AND ii.status IN ('pending','overdue','partial')
         WHERE i.company_id = $1 AND i.number ILIKE '%' || $2 || '%'
         ORDER BY i.date DESC LIMIT 5`,
        [companyId, ref],
      );
      for (const m of matches) {
        const amountDiff = Math.abs(absAmount - Math.abs(Number(m.amount_due || m.total_amount)));
        const amountMatch = amountDiff / absAmount;
        const score = amountMatch < 0.05 ? 95 : amountMatch < 0.10 ? 80 : 70;
        suggestions.push({
          ...m,
          match_score: score,
          match_reason: `Riferimento fattura "${ref}" trovato nel testo operazione${amountMatch < 0.05 ? " + importo corrispondente" : ""}`,
        });
      }
    }
  }

  // 2. Match by counterparty + amount
  if (tx.counterparty_name && suggestions.length < 3) {
    const cpMatches = await sql.unsafe(
      `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date, ii.amount_due, ii.paid_amount,
              ii.status, ii.installment_no, ii.installment_total, ii.direction,
              inv.number as invoice_number, inv.date as invoice_date,
              inv.counterparty->>'denom' as counterparty_name
       FROM invoice_installments ii
       JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE ii.company_id = $1
         AND ii.status IN ('pending','overdue','partial')
         AND inv.counterparty->>'denom' ILIKE '%' || $2 || '%'
         AND abs(ii.amount_due - ii.paid_amount) BETWEEN $3 * 0.90 AND $3 * 1.10
       ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $3) ASC
       LIMIT 5`,
      [companyId, tx.counterparty_name.split(" ")[0], absAmount],
    );
    for (const m of cpMatches) {
      const remaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
      const amountDiff = Math.abs(absAmount - remaining);
      const amountMatch = amountDiff / absAmount;
      const daysDiff = tx.date && m.due_date
        ? Math.abs((new Date(tx.date).getTime() - new Date(m.due_date).getTime()) / 86400000)
        : 999;
      let score = 70;
      if (amountMatch < 0.05 && daysDiff < 30) score = 85;
      else if (amountMatch < 0.10 && daysDiff < 60) score = 75;
      suggestions.push({
        ...m,
        match_score: score,
        match_reason: `Stessa controparte + importo simile (diff: €${amountDiff.toFixed(2)})${daysDiff < 30 ? " + data vicina" : ""}`,
      });
    }
  }

  // Deduplicate by installment_id
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => {
    const key = String(s.installment_id || s.invoice_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => Number(b.match_score) - Number(a.match_score));

  return {
    transaction: { id: tx.id, date: tx.date, amount: tx.amount, counterparty: tx.counterparty_name },
    suggestions: unique.slice(0, 5),
  };
}

async function embedQueryText(geminiKey: string, text: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 3072,
    }),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`Gemini embedding error: ${payload?.error?.message || res.status}`);
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== 3072) throw new Error("Embedding query invalido");
  return `[${values.map((v: number) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

async function handleSearchKnowledgeBase(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const query = String(args.query || "").trim();
  if (!query) return { error: "Query vuota" };

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!geminiKey) return { error: "GEMINI_API_KEY non configurata per knowledge base search" };

  const limit = Math.min(Number(args.limit) || 5, 20);

  // Generate query embedding
  const vectorLiteral = await embedQueryText(geminiKey, query);

  // Search using pgvector cosine distance via the pre-built function
  const results = await sql.unsafe(
    `SELECT kc.id, kc.document_id, kc.chunk_index, kc.content,
            kd.file_name,
            (1 - (kc.embedding <=> $2::vector(3072)))::numeric AS similarity
     FROM kb_chunks kc
     JOIN kb_documents kd ON kd.id = kc.document_id
     WHERE kc.company_id = $1
       AND kc.embedding IS NOT NULL
       AND kd.status = 'ready'
     ORDER BY kc.embedding <=> $2::vector(3072)
     LIMIT $3`,
    [companyId, vectorLiteral, limit],
  );

  return {
    query,
    results: results.map((r: Record<string, unknown>) => ({
      file_name: r.file_name,
      chunk_index: r.chunk_index,
      content: String(r.content || "").slice(0, 2000),
      similarity: Number(r.similarity || 0).toFixed(4),
    })),
    total: results.length,
  };
}

async function executeToolHandler(
  sql: SqlClient,
  companyId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "get_invoices":
      return handleGetInvoices(sql, companyId, toolInput);
    case "get_invoice_detail":
      return handleGetInvoiceDetail(sql, companyId, toolInput);
    case "get_bank_transactions":
      return handleGetBankTransactions(sql, companyId, toolInput);
    case "get_transaction_detail":
      return handleGetTransactionDetail(sql, companyId, toolInput);
    case "get_open_installments":
      return handleGetOpenInstallments(sql, companyId, toolInput);
    case "search_raw_text":
      return handleSearchRawText(sql, companyId, toolInput);
    case "get_counterparties":
      return handleGetCounterparties(sql, companyId, toolInput);
    case "get_company_stats":
      return handleGetCompanyStats(sql, companyId);
    case "suggest_reconciliation":
      return handleSuggestReconciliation(sql, companyId, toolInput);
    case "search_knowledge_base":
      return handleSearchKnowledgeBase(sql, companyId, toolInput);
    default:
      return { error: `Tool sconosciuto: ${toolName}` };
  }
}

/* ─── Claude API with tool use loop ───────── */

const SYSTEM_PROMPT = `Sei l'assistente AI di FinFlow, un gestionale finanziario per PMI italiane. Rispondi in italiano, in modo pratico e preciso.

Hai accesso ai dati dell'azienda tramite le seguenti funzioni. Quando l'utente chiede informazioni, usa le funzioni per recuperare dati reali. Non inventare mai dati. Per importi usa il formato italiano (1.234,56 €). Quando analizzi movimenti bancari, presta particolare attenzione al campo raw_text e extracted_refs per trovare riferimenti a fatture, mandati, contratti, rate.

Hai anche accesso alla Knowledge Base aziendale tramite search_knowledge_base. Se l'utente chiede informazioni su documenti caricati (contratti, regolamenti, procedure, manuali), cerca prima nella knowledge base.

Quando presenti tabelle o elenchi, usa il formato markdown. Quando menzioni importi, specifica sempre se è un'entrata o un'uscita. Per le date usa il formato italiano (gg/mm/aaaa).`;

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

async function runAiChat(
  messages: Array<{ role: string; content: unknown }>,
  sql: SqlClient,
  companyId: string,
  model: string,
): Promise<{ content: string; toolCalls: ToolCallInfo[]; tokensUsed: number }> {
  let currentMessages = [...messages];
  const allToolCalls: ToolCallInfo[] = [];
  let totalTokens = 0;

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: currentMessages,
        tools,
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${clip(err, 300)}`);
    }

    const data = await response.json();
    totalTokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    const toolUseBlocks = (data.content || []).filter(
      (b: { type: string }) => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
      const textBlock = (data.content || []).find(
        (b: { type: string }) => b.type === "text",
      );
      return {
        content: textBlock?.text || "Non ho trovato una risposta.",
        toolCalls: allToolCalls,
        tokensUsed: totalTokens,
      };
    }

    // Add assistant response with tool_use blocks
    currentMessages.push({ role: "assistant", content: data.content });

    // Execute tool calls
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeToolHandler(sql, companyId, toolUse.name, toolUse.input);
      allToolCalls.push({ name: toolUse.name, args: toolUse.input, result });

      // Truncate large results to avoid context overflow
      let resultStr = JSON.stringify(result);
      if (resultStr.length > 15000) {
        resultStr = resultStr.slice(0, 15000) + '... [risultati troncati]';
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultStr,
      });
    }

    currentMessages.push({ role: "user", content: toolResults });
  }

  return {
    content: "Ho raggiunto il limite di analisi. Ecco quello che ho trovato finora.",
    toolCalls: allToolCalls,
    tokensUsed: totalTokens,
  };
}

/* ─── title generation ────────────────────── */

async function generateTitle(userMessage: string): Promise<string> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 30,
        messages: [{
          role: "user",
          content: `Genera un titolo di 3-5 parole in italiano per questa domanda. Solo il titolo, nient'altro.\n\n"${clip(userMessage, 200)}"`,
        }],
      }),
    });
    if (!response.ok) return "Nuova conversazione";
    const data = await response.json();
    const text = data?.content?.[0]?.text || "Nuova conversazione";
    return clip(text.replace(/["""]/g, "").trim(), 60) || "Nuova conversazione";
  } catch {
    return "Nuova conversazione";
  }
}

/* ─── main handler ────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();

  if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY non configurata" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  // Parse JWT to get user_id
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const jwt = token ? parseJwt(token) : null;
  const userId = jwt?.sub as string | undefined;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const mode = String(body.mode || "chat");
  const companyId = String(body.company_id || "");
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    /* ──── MODE: INTERNAL (Layer 3) ──── */
    if (mode === "internal") {
      const task = String(body.task || "");
      const context = (body.context || {}) as Record<string, unknown>;

      let systemPrompt = SYSTEM_PROMPT;
      let userContent = "";
      let model = HAIKU_MODEL;

      if (task === "reconciliation_suggest") {
        model = HAIKU_MODEL;
        systemPrompt += "\n\nSei in modalità riconciliazione. Analizza il movimento bancario e suggerisci il miglior match con le rate/fatture fornite.";
        userContent = `Analizza questo movimento bancario e suggerisci la migliore corrispondenza con le rate aperte.\n\nMovimento: ${JSON.stringify(context)}`;
      } else {
        userContent = `Task: ${task}\nContesto: ${JSON.stringify(context)}`;
      }

      const result = await runAiChat(
        [{ role: "user", content: userContent }],
        sql,
        companyId,
        model,
      );

      return json({ task, result: { content: result.content, toolCalls: result.toolCalls } });
    }

    /* ──── MODE: CHAT (Layer 2) ──── */
    if (!userId) return json({ error: "Autenticazione richiesta" }, 401);

    const userMessage = String(body.message || "").trim();
    if (!userMessage) return json({ error: "Messaggio vuoto" }, 400);

    let chatId = body.chat_id ? String(body.chat_id) : null;
    let isNewChat = false;

    // Create new chat if needed
    if (!chatId) {
      const [newChat] = await sql`
        INSERT INTO ai_chats (company_id, user_id, title)
        VALUES (${companyId}, ${userId}, 'Nuova conversazione')
        RETURNING id
      `;
      chatId = newChat.id;
      isNewChat = true;
    }

    // Load chat history
    const history = await sql`
      SELECT role, content, tool_name, tool_args, tool_result
      FROM ai_messages
      WHERE chat_id = ${chatId}
      ORDER BY created_at DESC
      LIMIT ${MAX_CHAT_HISTORY}
    `;
    history.reverse();

    // Build messages for Claude
    const claudeMessages: Array<{ role: string; content: unknown }> = [];
    for (const msg of history) {
      if (msg.role === "user") {
        claudeMessages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        claudeMessages.push({ role: "assistant", content: msg.content });
      }
      // Tool messages are embedded in the flow already
    }
    claudeMessages.push({ role: "user", content: userMessage });

    // Run AI
    const result = await runAiChat(claudeMessages, sql, companyId, SONNET_MODEL);

    // Save messages
    await sql`
      INSERT INTO ai_messages (chat_id, role, content)
      VALUES (${chatId}, 'user', ${userMessage})
    `;

    // Save tool calls
    for (const tc of result.toolCalls) {
      await sql`
        INSERT INTO ai_messages (chat_id, role, content, tool_name, tool_args, tool_result)
        VALUES (${chatId}, 'tool', ${tc.name}, ${tc.name}, ${JSON.stringify(tc.args)}::jsonb, ${JSON.stringify(tc.result)}::jsonb)
      `;
    }

    // Save assistant response
    await sql`
      INSERT INTO ai_messages (chat_id, role, content, tokens_used, model)
      VALUES (${chatId}, 'assistant', ${result.content}, ${result.tokensUsed}, ${SONNET_MODEL})
    `;

    // Update chat metadata
    await sql`
      UPDATE ai_chats
      SET message_count = message_count + 2,
          total_tokens = total_tokens + ${result.tokensUsed},
          updated_at = now()
      WHERE id = ${chatId}
    `;

    // Generate title for new chats
    if (isNewChat) {
      const title = await generateTitle(userMessage);
      await sql`UPDATE ai_chats SET title = ${title} WHERE id = ${chatId}`;
    }

    return json({
      chat_id: chatId,
      message: { role: "assistant", content: result.content },
      tool_calls: result.toolCalls.map((tc) => ({
        name: tc.name,
        args: tc.args,
        result_count: Array.isArray(tc.result) ? tc.result.length : 1,
      })),
      tokens_used: result.tokensUsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ai-chat] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
