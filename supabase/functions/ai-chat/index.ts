import postgres from "npm:postgres@3.4.5";
import {
  getAccountingSystemPrompt,
  getUserInstructionsBlock,
  type CompanyContext,
} from "../_shared/accounting-system-prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SONNET_MODEL = "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const THINKING_MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 10;
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
      "Cerca fatture dell'azienda con filtri opzionali. Ritorna: number, date, total_amount, direction, doc_type, counterparty, status. Per ricerche full-text (prodotti, CIG, CUP, codici), usa search_invoices.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ricerca parziale ILIKE)" },
        piva: { type: "string", description: "P.IVA o codice fiscale controparte (ricerca parziale)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive (emesse/vendita), in = passive (ricevute/acquisto)" },
        doc_type: { type: "string", description: "Tipo documento FatturaPA: TD01, TD04, TD24, etc." },
        number_contains: { type: "string", description: "Ricerca parziale nel numero fattura" },
        line_description: { type: "string", description: "Cerca nelle descrizioni righe fattura (ILIKE)" },
        keyword: { type: "string", description: "Cerca nelle keywords estratte dall'AI (da extracted_summary)" },
        amount_min: { type: "number", description: "Importo totale minimo" },
        amount_max: { type: "number", description: "Importo totale massimo" },
        classified: { type: "boolean", description: "true = solo fatture classificate, false = solo non classificate" },
        category_name: { type: "string", description: "Filtra per nome categoria classificazione (ILIKE)" },
        cost_center_code: { type: "string", description: "Filtra per codice centro di costo" },
        limit: { type: "number", description: "Max risultati (default 20, max 100)" },
      },
    },
  },
  {
    name: "search_invoices",
    description:
      "Ricerca full-text nelle fatture: cerca in righe fattura, keywords estratte dall'AI (extracted_summary), numero fattura, nome controparte. Usa per domande tipo 'fatture con prodotto X', 'fattura con CIG...', 'fatture con keyword Y'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Testo da cercare (prodotti, codici, CIG, CUP, riferimenti)" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive (emesse/vendita), in = passive (ricevute/acquisto)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        limit: { type: "number", description: "Max risultati (default 20, max 100)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_invoice_detail",
    description: "Dettaglio completo di una singola fattura: righe, importi, rate associate, extracted_summary AI.",
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
        direction: { type: "string", enum: ["in", "out"], description: "out = incassi attesi (fatture attive/emesse), in = pagamenti da fare (fatture passive/ricevute)" },
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
    description: "Lista controparti dell'azienda con statistiche aggregate (fatturato, crediti, debiti). Supporta filtri per ruolo e ordinamento.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Ricerca nel nome (ILIKE)" },
        role: { type: "string", enum: ["client", "supplier", "both"], description: "Filtra per ruolo: client = clienti, supplier = fornitori, both = entrambi" },
        order_by: { type: "string", enum: ["name", "fatturato_desc", "credito_desc", "debito_desc"], description: "Ordinamento (default: name)" },
        date_from: { type: "string", description: "Data inizio per statistiche aggregate YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine per statistiche aggregate YYYY-MM-DD" },
        limit: { type: "number", description: "Default 20, max 100" },
      },
    },
  },
  {
    name: "get_company_stats",
    description:
      "KPI generali: n. fatture attive/passive, n. movimenti, totale scaduto, totale da incassare, totale da pagare, saldo banca, top 5 clienti/fornitori per fatturato.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD per filtrare conteggi fatture e movimenti" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD per filtrare conteggi fatture e movimenti" },
      },
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
  {
    name: "get_invoices_with_lines",
    description:
      "Ritorna fatture CON le righe dettaglio (descrizione, quantità, prezzo unitario, totale) in un'unica query. Usa questo al posto di get_invoices + get_invoice_detail quando devi analizzare articoli, quantità o tonnellate di molte fatture. Max 50 fatture per chiamata.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ILIKE)" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive (emesse/vendita), in = passive (ricevute/acquisto)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        line_description: { type: "string", description: "Filtra righe che contengono questa parola (ILIKE)" },
        limit: { type: "number", description: "Default 50, max 50" },
      },
    },
  },
  {
    name: "aggregate_invoice_lines",
    description:
      "Calcola totali aggregati delle righe fattura: somma quantità, somma importi, prezzo medio, conteggio. Raggruppa per descrizione prodotto o per mese. Usa questo per domande tipo 'quante tonnellate di calcare nel 2025', 'fatturato mensile per Buzzi', 'prezzo medio calcare'. NON usare get_invoices_with_lines per fare somme — usa questo.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ILIKE)" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive (emesse/vendita), in = passive (ricevute/acquisto)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        line_description: { type: "string", description: "Filtra righe che contengono questa parola (ILIKE)" },
        group_by: { type: "string", enum: ["product", "month", "counterparty", "none"], description: "Raggruppa per: product (descrizione riga), month (mese fattura), counterparty, none (totale unico). Default: product" },
      },
    },
  },
  {
    name: "get_distinct_line_descriptions",
    description:
      "Ritorna le descrizioni DISTINTE delle righe fattura con conteggio e totali. Usa per esplorare quali prodotti/servizi esistono per una controparte, tipo 'che articoli fatturiamo a Buzzi?', 'che servizi acquistiamo?'. Ritorna una riga per ogni descrizione unica.",
    input_schema: {
      type: "object" as const,
      properties: {
        counterparty: { type: "string", description: "Nome controparte (ILIKE)" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive (emesse/vendita), in = passive (ricevute/acquisto)" },
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        limit: { type: "number", description: "Default 50" },
      },
    },
  },
  {
    name: "get_classification_stats",
    description:
      "Statistiche sulla classificazione fatture: quante classificate/non classificate, breakdown per categoria, per centro di costo, per conto. Utile per domande tipo 'quante fatture sono classificate?', 'distribuzione per categoria'.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Data inizio YYYY-MM-DD" },
        date_to: { type: "string", description: "Data fine YYYY-MM-DD" },
        direction: { type: "string", enum: ["in", "out"], description: "out = attive, in = passive" },
      },
    },
  },
  {
    name: "classify_invoice",
    description:
      "Classifica automaticamente fatture usando AI (matching deterministico + Claude Haiku). Input: lista di invoice_ids (max 10). Assegna categoria, conto, centro di costo a livello riga e fattura. Usa quando l'utente chiede di classificare fatture specifiche.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoice_ids: {
          type: "array",
          items: { type: "string" },
          description: "Lista UUID fatture da classificare (max 10)",
        },
      },
      required: ["invoice_ids"],
    },
  },
  {
    name: "get_chart_of_accounts",
    description:
      "Ritorna il piano dei conti dell'azienda. Struttura gerarchica con codice, nome, sezione. Usa per domande tipo 'dove metto una spesa ristorante?', 'qual e il conto per il gasolio?', 'mostrami il piano dei conti'.",
    input_schema: {
      type: "object" as const,
      properties: {
        section: {
          type: "string",
          enum: ["revenue", "cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "all"],
          description: "Filtra per sezione. Default: all",
        },
        search: { type: "string", description: "Ricerca nel nome o codice del conto (ILIKE)" },
      },
    },
  },
  {
    name: "get_categories",
    description:
      "Ritorna le categorie dell'azienda (ricavi e costi). Usa per domande su come categorizzare spese/ricavi.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["revenue", "expense", "both", "all"],
          description: "Filtra per tipo. Default: all",
        },
      },
    },
  },
  {
    name: "get_cost_centers",
    description:
      "Ritorna i centri di costo (progetti) dell'azienda con struttura gerarchica a 2 livelli. Livello 1 = sedi operative, Livello 2 = attivita.",
    input_schema: {
      type: "object" as const,
      properties: {
        parent_code: { type: "string", description: "Filtra per centro padre (es. 'BRE' per sotto-centri Brescia)" },
        status: {
          type: "string",
          enum: ["active", "completed", "suspended", "all"],
          description: "Default: active",
        },
      },
    },
  },
  {
    name: "get_articles",
    description:
      "Ritorna gli articoli/prodotti dell'azienda con keywords e statistiche (assegnamenti, tonnellate, fatturato). Usa per domande su prodotti, tonnellate, prezzi medi.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Ricerca nel nome o codice articolo" },
        category: { type: "string", description: "Filtra per categoria articolo" },
      },
    },
  },
  {
    name: "get_company_settings",
    description:
      "Ritorna le impostazioni dell'azienda: nome, P.IVA, conti bancari, DSO/PSO default. Usa per domande su configurazione aziendale.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_reconciliation_stats",
    description:
      "Statistiche riconciliazione: quanti movimenti riconciliati, parziali, da riconciliare, suggerimenti pendenti.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "Data inizio (YYYY-MM-DD)" },
        date_to: { type: "string", description: "Data fine (YYYY-MM-DD)" },
      },
    },
  },
  {
    name: "save_user_instruction",
    description:
      "Salva un'istruzione/regola dell'utente per le operazioni AI future (classificazione, riconciliazione, ecc.). Usa quando l'utente dichiara una regola, una convenzione o una preferenza che dovrebbe essere ricordata. Esempi: 'le fatture CREDEMLEASING sono sempre leasing veicoli', 'il trasporto calcare va in B14-FRA', 'i pagamenti F24 non vanno riconciliati'.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string", description: "Il testo dell'istruzione/regola" },
        scope: {
          type: "string",
          enum: ["general", "counterparty", "category", "classification", "reconciliation"],
          description: "Ambito: general = regola generica, counterparty = specifica per controparte, category = per categoria, classification = per classificazione fatture, reconciliation = per riconciliazione",
        },
        scope_ref: { type: "string", description: "UUID opzionale dell'entità correlata (counterparty_id, category_id). Cercalo prima con gli altri tool se necessario." },
      },
      required: ["instruction", "scope"],
    },
  },
  {
    name: "get_user_instructions",
    description:
      "Recupera le istruzioni/regole salvate dall'utente. Usa per mostrare all'utente le sue regole attive o per verificare se una regola esiste già prima di salvarne una nuova.",
    input_schema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string",
          enum: ["general", "counterparty", "category", "classification", "reconciliation", "all"],
          description: "Filtra per ambito. 'all' = tutte le istruzioni. Default: all",
        },
        scope_ref: { type: "string", description: "UUID opzionale per filtrare per entità specifica" },
      },
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
  if (args.piva) {
    conditions.push(`(i.counterparty->>'piva' ILIKE '%' || $${idx} || '%' OR i.counterparty->>'cf' ILIKE '%' || $${idx} || '%')`);
    params.push(args.piva); idx++;
  }
  if (args.line_description) {
    conditions.push(`EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id = i.id AND il.description ILIKE '%' || $${idx} || '%')`);
    params.push(args.line_description); idx++;
  }
  if (args.keyword) {
    conditions.push(`i.extracted_summary::text ILIKE '%' || $${idx} || '%'`);
    params.push(args.keyword); idx++;
  }
  if (typeof args.amount_min === "number") {
    conditions.push(`i.total_amount >= $${idx}`);
    params.push(args.amount_min); idx++;
  }
  if (typeof args.amount_max === "number") {
    conditions.push(`i.total_amount <= $${idx}`);
    params.push(args.amount_max); idx++;
  }
  // Classification filters
  if (args.classified === true) {
    conditions.push(`EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id AND ic.verified = true)`);
  } else if (args.classified === false) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id)`);
  }
  if (args.category_name) {
    conditions.push(`EXISTS (SELECT 1 FROM invoice_classifications ic JOIN categories c ON c.id = ic.category_id WHERE ic.invoice_id = i.id AND c.name ILIKE '%' || $${idx} || '%')`);
    params.push(args.category_name); idx++;
  }
  if (args.cost_center_code) {
    conditions.push(`EXISTS (SELECT 1 FROM invoice_projects ip JOIN projects p ON p.id = ip.project_id WHERE ip.invoice_id = i.id AND p.code = $${idx})`);
    params.push(args.cost_center_code); idx++;
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

async function handleSearchInvoices(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const queryText = String(args.query || "").trim();
  if (!queryText) return [];

  const words = queryText.split(/\s+/).filter((w: string) => w.length >= 2);
  if (words.length === 0) return [];

  const conditions = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  for (const word of words) {
    conditions.push(`(
      EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id = i.id AND il.description ILIKE '%' || $${idx} || '%')
      OR i.extracted_summary::text ILIKE '%' || $${idx} || '%'
      OR i.number ILIKE '%' || $${idx} || '%'
      OR i.counterparty->>'denom' ILIKE '%' || $${idx} || '%'
    )`);
    params.push(word); idx++;
  }

  if (args.direction) {
    conditions.push(`i.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.date_from) {
    conditions.push(`i.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`i.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  const query = `SELECT i.id, i.number, i.date, i.total_amount, i.direction, i.doc_type,
            i.counterparty->>'denom' as counterparty_name,
            i.payment_status, i.extraction_status,
            (SELECT string_agg(il.description, ' | ' ORDER BY il.line_number)
             FROM invoice_lines il WHERE il.invoice_id = i.id) as line_descriptions
     FROM invoices i
     WHERE ${conditions.join(" AND ")}
     ORDER BY i.date DESC
     LIMIT $${idx}`;

  console.log(`[search_invoices] query="${queryText}" words=${JSON.stringify(words)} direction=${args.direction || "any"}`);
  console.log(`[search_invoices] SQL conditions: ${conditions.join(" AND ")}`);

  const results = await sql.unsafe(query, params);
  console.log(`[search_invoices] found ${results.length} results`);
  if (results.length > 0) {
    console.log(`[search_invoices] first result: ${results[0].number} - ${results[0].counterparty_name} - lines: ${clip(results[0].line_descriptions, 200)}`);
  }

  return results;
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
  if (args.role === "client") {
    conditions.push(`cp.type IN ('client', 'both')`);
  } else if (args.role === "supplier") {
    conditions.push(`cp.type IN ('supplier', 'both')`);
  }

  let dateFilter = "";
  if (args.date_from) {
    dateFilter += ` AND inv.date >= $${idx}::date`;
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    dateFilter += ` AND inv.date <= $${idx}::date`;
    params.push(args.date_to); idx++;
  }

  const orderBy = args.order_by === "fatturato_desc" ? "agg.fatturato_totale DESC NULLS LAST"
    : args.order_by === "credito_desc" ? "agg.credito_residuo DESC NULLS LAST"
    : args.order_by === "debito_desc" ? "agg.debito_residuo DESC NULLS LAST"
    : "cp.name";

  const limit = Math.min(Number(args.limit) || 20, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT cp.id, cp.name, cp.vat_number, cp.fiscal_code, cp.type,
            coalesce(agg.fatture_attive, 0) as fatture_attive,
            coalesce(agg.fatture_passive, 0) as fatture_passive,
            coalesce(agg.fatturato_totale, 0) as fatturato_totale,
            coalesce(agg.credito_residuo, 0) as credito_residuo,
            coalesce(agg.debito_residuo, 0) as debito_residuo
     FROM counterparties cp
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE inv.direction = 'out') as fatture_attive,
         count(*) FILTER (WHERE inv.direction = 'in') as fatture_passive,
         coalesce(sum(inv.total_amount), 0) as fatturato_totale,
         coalesce(sum(CASE WHEN inv.direction = 'out' THEN ii_agg.residuo ELSE 0 END), 0) as credito_residuo,
         coalesce(sum(CASE WHEN inv.direction = 'in' THEN ii_agg.residuo ELSE 0 END), 0) as debito_residuo
       FROM invoices inv
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(ii.amount_due - ii.paid_amount), 0) as residuo
         FROM invoice_installments ii
         WHERE ii.invoice_id = inv.id AND ii.status IN ('pending','overdue','partial')
       ) ii_agg ON true
       WHERE inv.counterparty_id = cp.id${dateFilter}
     ) agg ON true
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${orderBy}
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetCompanyStats(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const params: unknown[] = [companyId];
  let idx = 2;

  let invDateFilter = "";
  let btDateFilter = "";
  if (args.date_from) {
    invDateFilter += ` AND date >= $${idx}::date`;
    btDateFilter += ` AND date >= $${idx}::date`;
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    invDateFilter += ` AND date <= $${idx}::date`;
    btDateFilter += ` AND date <= $${idx}::date`;
    params.push(args.date_to); idx++;
  }

  const [stats] = await sql.unsafe(
    `SELECT
      (SELECT count(*) FROM invoices WHERE company_id = $1 AND direction = 'out'${invDateFilter}) as fatture_attive,
      (SELECT count(*) FROM invoices WHERE company_id = $1 AND direction = 'in'${invDateFilter}) as fatture_passive,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1${btDateFilter}) as movimenti_totali,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND direction = 'in' AND status IN ('pending', 'overdue', 'partial')) as totale_da_pagare,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND direction = 'out' AND status IN ('pending', 'overdue', 'partial')) as totale_da_incassare,
      (SELECT coalesce(sum(amount_due - paid_amount), 0) FROM invoice_installments WHERE company_id = $1 AND status = 'overdue') as totale_scaduto,
      (SELECT count(*) FROM bank_transactions WHERE company_id = $1 AND reconciliation_status = 'unmatched') as movimenti_non_riconciliati,
      (SELECT coalesce(sum(amount), 0) FROM bank_transactions WHERE company_id = $1) as saldo_banca`,
    params,
  );

  // Build top5 date filter with i. prefix
  let top5DateFilter = "";
  if (args.date_from && args.date_to) {
    top5DateFilter = ` AND i.date >= $2::date AND i.date <= $3::date`;
  } else if (args.date_from) {
    top5DateFilter = ` AND i.date >= $2::date`;
  } else if (args.date_to) {
    top5DateFilter = ` AND i.date <= $2::date`;
  }

  const topClienti = await sql.unsafe(
    `SELECT cp.name, coalesce(sum(i.total_amount), 0) as fatturato
     FROM counterparties cp
     JOIN invoices i ON i.counterparty_id = cp.id AND i.direction = 'out'
     WHERE cp.company_id = $1${top5DateFilter}
     GROUP BY cp.id, cp.name
     ORDER BY fatturato DESC
     LIMIT 5`,
    params,
  );

  const topFornitori = await sql.unsafe(
    `SELECT cp.name, coalesce(sum(i.total_amount), 0) as fatturato
     FROM counterparties cp
     JOIN invoices i ON i.counterparty_id = cp.id AND i.direction = 'in'
     WHERE cp.company_id = $1${top5DateFilter}
     GROUP BY cp.id, cp.name
     ORDER BY fatturato DESC
     LIMIT 5`,
    params,
  );

  // Classification stats
  const [classifStats] = await sql.unsafe(
    `SELECT
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${invDateFilter}
        AND EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id AND ic.verified = true)) as classificate_verificate,
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${invDateFilter}
        AND EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id AND ic.verified = false)) as classificate_ai,
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${invDateFilter}
        AND NOT EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id)) as non_classificate`,
    params,
  );

  return {
    ...stats,
    top_5_clienti: topClienti,
    top_5_fornitori: topFornitori,
    classificazione: classifStats,
  };
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

async function handleGetInvoicesWithLines(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`i.counterparty->>'denom' ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.direction) {
    conditions.push(`i.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.date_from) {
    conditions.push(`i.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`i.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }
  if (args.line_description) {
    conditions.push(`EXISTS (SELECT 1 FROM invoice_lines il2 WHERE il2.invoice_id = i.id AND il2.description ILIKE '%' || $${idx} || '%')`);
    params.push(args.line_description); idx++;
  }

  const limit = Math.min(Number(args.limit) || 50, 50);
  params.push(limit);

  return await sql.unsafe(
    `SELECT i.id, i.number, i.date, i.total_amount, i.direction,
            i.counterparty->>'denom' as counterparty_name,
            json_agg(json_build_object(
              'description', il.description,
              'quantity', il.quantity,
              'unit_price', il.unit_price,
              'total_price', il.total_price,
              'vat_rate', il.vat_rate,
              'line_number', il.line_number
            ) ORDER BY il.line_number) as lines
     FROM invoices i
     LEFT JOIN invoice_lines il ON il.invoice_id = i.id
     WHERE ${conditions.join(" AND ")}
     GROUP BY i.id
     ORDER BY i.date DESC
     LIMIT $${idx}`,
    params,
  );
}

async function handleAggregateInvoiceLines(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`i.counterparty->>'denom' ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.direction) {
    conditions.push(`i.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.date_from) {
    conditions.push(`i.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`i.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }
  if (args.line_description) {
    conditions.push(`il.description ILIKE '%' || $${idx} || '%'`);
    params.push(args.line_description); idx++;
  }

  const where = conditions.join(" AND ");
  const groupBy = String(args.group_by || "product");

  if (groupBy === "month") {
    return await sql.unsafe(
      `SELECT TO_CHAR(i.date, 'YYYY-MM') as gruppo,
              COUNT(*) as n_righe,
              SUM(il.quantity) as totale_quantita,
              SUM(il.total_price) as totale_importo,
              CASE WHEN SUM(il.quantity) > 0 THEN SUM(il.total_price) / SUM(il.quantity) ELSE 0 END as prezzo_medio
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE ${where}
       GROUP BY TO_CHAR(i.date, 'YYYY-MM')
       ORDER BY gruppo`,
      params,
    );
  }

  if (groupBy === "counterparty") {
    return await sql.unsafe(
      `SELECT i.counterparty->>'denom' as gruppo,
              COUNT(*) as n_righe,
              COUNT(DISTINCT i.id) as n_fatture,
              SUM(il.quantity) as totale_quantita,
              SUM(il.total_price) as totale_importo,
              CASE WHEN SUM(il.quantity) > 0 THEN SUM(il.total_price) / SUM(il.quantity) ELSE 0 END as prezzo_medio
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE ${where}
       GROUP BY i.counterparty->>'denom'
       ORDER BY totale_importo DESC`,
      params,
    );
  }

  if (groupBy === "none") {
    return await sql.unsafe(
      `SELECT 'TOTALE' as gruppo,
              COUNT(*) as n_righe,
              COUNT(DISTINCT i.id) as n_fatture,
              SUM(il.quantity) as totale_quantita,
              SUM(il.total_price) as totale_importo,
              CASE WHEN SUM(il.quantity) > 0 THEN SUM(il.total_price) / SUM(il.quantity) ELSE 0 END as prezzo_medio,
              MIN(i.date) as data_prima,
              MAX(i.date) as data_ultima
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE ${where}`,
      params,
    );
  }

  // Default: group by product (description)
  return await sql.unsafe(
    `SELECT il.description as gruppo,
            COUNT(*) as n_righe,
            COUNT(DISTINCT i.id) as n_fatture,
            SUM(il.quantity) as totale_quantita,
            SUM(il.total_price) as totale_importo,
            CASE WHEN SUM(il.quantity) > 0 THEN SUM(il.total_price) / SUM(il.quantity) ELSE 0 END as prezzo_medio,
            MIN(i.date) as data_prima,
            MAX(i.date) as data_ultima
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     WHERE ${where}
     GROUP BY il.description
     ORDER BY totale_importo DESC`,
    params,
  );
}

async function handleGetDistinctLineDescriptions(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const conditions = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (args.counterparty) {
    conditions.push(`i.counterparty->>'denom' ILIKE '%' || $${idx} || '%'`);
    params.push(args.counterparty); idx++;
  }
  if (args.direction) {
    conditions.push(`i.direction = $${idx}`);
    params.push(args.direction); idx++;
  }
  if (args.date_from) {
    conditions.push(`i.date >= $${idx}::date`);
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    conditions.push(`i.date <= $${idx}::date`);
    params.push(args.date_to); idx++;
  }

  const limit = Math.min(Number(args.limit) || 50, 100);
  params.push(limit);

  return await sql.unsafe(
    `SELECT il.description,
            COUNT(*) as n_occorrenze,
            COUNT(DISTINCT i.id) as n_fatture,
            SUM(il.quantity) as totale_quantita,
            SUM(il.total_price) as totale_importo,
            CASE WHEN SUM(il.quantity) > 0
              THEN SUM(il.total_price) / SUM(il.quantity)
              ELSE 0 END as prezzo_medio,
            MIN(i.date) as prima_fattura,
            MAX(i.date) as ultima_fattura
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY il.description
     ORDER BY totale_importo DESC
     LIMIT $${idx}`,
    params,
  );
}

async function handleGetClassificationStats(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const params: unknown[] = [companyId];
  let idx = 2;

  let invDateFilter = "";
  let directionFilter = "";
  if (args.date_from) {
    invDateFilter += ` AND i.date >= $${idx}::date`;
    params.push(args.date_from); idx++;
  }
  if (args.date_to) {
    invDateFilter += ` AND i.date <= $${idx}::date`;
    params.push(args.date_to); idx++;
  }
  if (args.direction) {
    directionFilter = ` AND i.direction = $${idx}`;
    params.push(args.direction); idx++;
  }

  const dateDir = invDateFilter + directionFilter;

  // Overall counts
  const [counts] = await sql.unsafe(
    `SELECT
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${dateDir}) as totale_fatture,
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${dateDir}
        AND EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id AND ic.verified = true)) as classificate_verificate,
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${dateDir}
        AND EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id AND ic.verified = false)) as classificate_ai,
      (SELECT count(*) FROM invoices i WHERE i.company_id = $1${dateDir}
        AND NOT EXISTS (SELECT 1 FROM invoice_classifications ic WHERE ic.invoice_id = i.id)) as non_classificate`,
    params,
  );

  // Breakdown by category
  const byCategory = await sql.unsafe(
    `SELECT c.name as categoria, count(*) as n_fatture, coalesce(sum(i.total_amount), 0) as importo_totale
     FROM invoice_classifications ic
     JOIN invoices i ON i.id = ic.invoice_id
     LEFT JOIN categories c ON c.id = ic.category_id
     WHERE i.company_id = $1${dateDir}
     GROUP BY c.name
     ORDER BY n_fatture DESC
     LIMIT 20`,
    params,
  );

  // Breakdown by cost center
  const byCostCenter = await sql.unsafe(
    `SELECT p.code as cdc_codice, p.name as cdc_nome, count(DISTINCT ip.invoice_id) as n_fatture
     FROM invoice_projects ip
     JOIN invoices i ON i.id = ip.invoice_id
     JOIN projects p ON p.id = ip.project_id
     WHERE i.company_id = $1${dateDir}
     GROUP BY p.code, p.name
     ORDER BY n_fatture DESC
     LIMIT 20`,
    params,
  );

  // Breakdown by account
  const byAccount = await sql.unsafe(
    `SELECT coa.code as codice_conto, coa.name as nome_conto, count(*) as n_fatture
     FROM invoice_classifications ic
     JOIN invoices i ON i.id = ic.invoice_id
     LEFT JOIN chart_of_accounts coa ON coa.id = ic.account_id
     WHERE i.company_id = $1${dateDir} AND ic.account_id IS NOT NULL
     GROUP BY coa.code, coa.name
     ORDER BY n_fatture DESC
     LIMIT 20`,
    params,
  );

  return {
    ...counts,
    per_categoria: byCategory,
    per_centro_di_costo: byCostCenter,
    per_conto: byAccount,
  };
}

async function handleClassifyInvoice(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const invoiceIds = args.invoice_ids;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return { error: "invoice_ids deve essere un array non vuoto" };
  }
  if (invoiceIds.length > 10) {
    return { error: "Massimo 10 fatture per chiamata" };
  }

  // Call the classification-ai-suggest edge function internally
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return { error: "SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurati" };
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/classification-ai-suggest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ invoice_ids: invoiceIds }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { error: `Errore classificazione: ${response.status} ${clip(errText, 200)}` };
    }

    const result = await response.json();
    // Return a summarized version for chat context
    const summary = {
      stats: result.stats,
      results: (result.results || []).map((r: Record<string, unknown>) => ({
        invoice_id: r.invoice_id,
        confidence: r.confidence,
        category: r.category_name,
        account: r.account_name,
        cost_centers: r.cost_centers,
        line_count: Array.isArray(r.lines) ? r.lines.length : 0,
      })),
    };
    return summary;
  } catch (err) {
    return { error: `Errore chiamata classificazione: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ─── new handlers: chart of accounts, categories, cost centers, articles, settings, reconciliation ─── */

async function handleGetChartOfAccounts(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const section = String(args.section || "all");
  const search = args.search ? String(args.search) : null;
  const rows = await sql`
    SELECT code, name, section, parent_code, level, is_header
    FROM chart_of_accounts
    WHERE company_id = ${companyId} AND active = true
      AND (${section} = 'all' OR section = ${section})
      AND (${search}::text IS NULL OR name ILIKE ${"%" + (search || "") + "%"} OR code ILIKE ${"%" + (search || "") + "%"})
    ORDER BY sort_order, code
    LIMIT 200`;
  return rows;
}

async function handleGetCategories(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const catType = String(args.type || "all");
  const rows = await sql`
    SELECT name, type, color, description
    FROM categories
    WHERE company_id = ${companyId} AND active = true
      AND (${catType} = 'all' OR type = ${catType} OR type = 'both')
    ORDER BY sort_order, name`;
  return rows;
}

async function handleGetCostCenters(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const parentCode = args.parent_code ? String(args.parent_code) : null;
  const status = String(args.status || "active");
  const rows = await sql`
    SELECT p.code, p.name, p.color, p.status, p.description,
           parent.code as parent_code, parent.name as parent_name
    FROM projects p
    LEFT JOIN projects parent ON parent.id = p.parent_id
    WHERE p.company_id = ${companyId}
      AND (${status} = 'all' OR p.status = ${status})
      AND (${parentCode}::text IS NULL OR parent.code = ${parentCode} OR p.code = ${parentCode})
    ORDER BY COALESCE(parent.code, p.code), p.code`;
  return rows;
}

async function handleGetArticles(sql: SqlClient, companyId: string, args: Record<string, unknown>) {
  const search = args.search ? String(args.search) : null;
  const category = args.category ? String(args.category) : null;
  const rows = await sql`
    SELECT a.code, a.name, a.description, a.unit, a.category, a.direction, a.keywords,
           (SELECT count(*) FROM invoice_line_articles ila WHERE ila.article_id = a.id AND ila.verified = true)::int as assigned_count,
           (SELECT coalesce(sum(ila.quantity), 0) FROM invoice_line_articles ila WHERE ila.article_id = a.id AND ila.verified = true)::float as total_quantity,
           (SELECT coalesce(sum(ila.total_price), 0) FROM invoice_line_articles ila WHERE ila.article_id = a.id AND ila.verified = true)::float as total_revenue
    FROM articles a
    WHERE a.company_id = ${companyId} AND a.active = true
      AND (${search}::text IS NULL OR a.name ILIKE ${"%" + (search || "") + "%"} OR a.code ILIKE ${"%" + (search || "") + "%"})
      AND (${category}::text IS NULL OR a.category = ${category})
    ORDER BY a.code`;
  return rows;
}

async function handleGetCompanySettings(sql: SqlClient, companyId: string, _args: Record<string, unknown>) {
  const [company] = await sql`
    SELECT c.name, c.piva, c.cf, c.city, c.default_dso, c.default_pso,
           (SELECT json_agg(json_build_object('name', ba.name, 'iban', ba.iban, 'opening_balance', ba.opening_balance))
            FROM bank_accounts ba WHERE ba.company_id = c.id) as bank_accounts
    FROM companies c
    WHERE c.id = ${companyId}`;
  return company || { error: "Azienda non trovata" };
}

async function handleGetReconciliationStats(sql: SqlClient, companyId: string, _args: Record<string, unknown>) {
  const [stats] = await sql`
    SELECT
      (SELECT count(*) FROM bank_transactions WHERE company_id = ${companyId} AND reconciliation_status = 'matched')::int as riconciliati,
      (SELECT count(*) FROM bank_transactions WHERE company_id = ${companyId} AND reconciliation_status = 'partial')::int as parziali,
      (SELECT count(*) FROM bank_transactions WHERE company_id = ${companyId} AND reconciliation_status = 'unmatched')::int as da_riconciliare,
      (SELECT count(*) FROM reconciliation_suggestions WHERE company_id = ${companyId} AND status = 'pending')::int as suggerimenti_pendenti`;
  return stats;
}

async function handleSaveUserInstruction(
  sql: SqlClient,
  companyId: string,
  args: Record<string, unknown>,
) {
  const instruction = String(args.instruction || "").trim();
  if (!instruction) return { error: "Istruzione vuota" };

  const scope = String(args.scope || "general");
  const scopeRef = args.scope_ref ? String(args.scope_ref) : null;

  try {
    console.log(`[save_user_instruction] Saving: company=${companyId}, scope=${scope}, scopeRef=${scopeRef}, instruction="${instruction}"`);
    const [row] = await sql`
      INSERT INTO user_instructions (company_id, scope, scope_ref, instruction, source)
      VALUES (${companyId}, ${scope}, ${scopeRef}, ${instruction}, 'ai_chat')
      RETURNING id, scope, instruction`;
    console.log(`[save_user_instruction] SUCCESS: id=${row.id}`);
    return { saved: true, id: row.id, scope: row.scope, instruction: row.instruction };
  } catch (err) {
    console.error(`[save_user_instruction] ERROR:`, err);
    return { error: `Errore salvataggio: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleGetUserInstructions(
  sql: SqlClient,
  companyId: string,
  args: Record<string, unknown>,
) {
  const scope = String(args.scope || "all");
  const scopeRef = args.scope_ref ? String(args.scope_ref) : null;

  if (scope === "all" && !scopeRef) {
    return await sql`
      SELECT id, scope, scope_ref, instruction, source, created_at
      FROM user_instructions
      WHERE company_id = ${companyId} AND active = true
      ORDER BY scope, created_at`;
  }

  if (scopeRef) {
    return await sql`
      SELECT id, scope, scope_ref, instruction, source, created_at
      FROM user_instructions
      WHERE company_id = ${companyId} AND active = true
        AND (${scope} = 'all' OR scope = ${scope})
        AND scope_ref = ${scopeRef}::uuid
      ORDER BY created_at`;
  }

  return await sql`
    SELECT id, scope, scope_ref, instruction, source, created_at
    FROM user_instructions
    WHERE company_id = ${companyId} AND active = true AND scope = ${scope}
    ORDER BY created_at`;
}

async function executeToolHandler(
  sql: SqlClient,
  companyId: string,
  toolName: string,
  // Log every tool call for debugging
  toolInput: Record<string, unknown>,
): Promise<unknown> {
  console.log(`[tool_call] ${toolName} args=${JSON.stringify(toolInput)}`);
  switch (toolName) {
    case "get_invoices":
      return handleGetInvoices(sql, companyId, toolInput);
    case "search_invoices":
      return handleSearchInvoices(sql, companyId, toolInput);
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
      return handleGetCompanyStats(sql, companyId, toolInput);
    case "suggest_reconciliation":
      return handleSuggestReconciliation(sql, companyId, toolInput);
    case "search_knowledge_base":
      return handleSearchKnowledgeBase(sql, companyId, toolInput);
    case "get_invoices_with_lines":
      return handleGetInvoicesWithLines(sql, companyId, toolInput);
    case "aggregate_invoice_lines":
      return handleAggregateInvoiceLines(sql, companyId, toolInput);
    case "get_distinct_line_descriptions":
      return handleGetDistinctLineDescriptions(sql, companyId, toolInput);
    case "get_classification_stats":
      return handleGetClassificationStats(sql, companyId, toolInput);
    case "classify_invoice":
      return handleClassifyInvoice(sql, companyId, toolInput);
    case "get_chart_of_accounts":
      return handleGetChartOfAccounts(sql, companyId, toolInput);
    case "get_categories":
      return handleGetCategories(sql, companyId, toolInput);
    case "get_cost_centers":
      return handleGetCostCenters(sql, companyId, toolInput);
    case "get_articles":
      return handleGetArticles(sql, companyId, toolInput);
    case "get_company_settings":
      return handleGetCompanySettings(sql, companyId, toolInput);
    case "get_reconciliation_stats":
      return handleGetReconciliationStats(sql, companyId, toolInput);
    case "save_user_instruction":
      return handleSaveUserInstruction(sql, companyId, toolInput);
    case "get_user_instructions":
      return handleGetUserInstructions(sql, companyId, toolInput);
    default:
      return { error: `Tool sconosciuto: ${toolName}` };
  }
}

/* ─── Claude API with tool use loop ───────── */

const SYSTEM_PROMPT = `Sei l'assistente AI di FinFlow, un gestionale finanziario per PMI italiane. Rispondi in italiano, in modo pratico e preciso.

Hai accesso COMPLETO a tutti i dati dell'azienda:
- Fatture (attive e passive) con righe, rate, articoli assegnati
- Movimenti bancari con raw_text e riferimenti estratti
- Controparti con statistiche finanziarie
- Piano dei conti dell'azienda (usa get_chart_of_accounts)
- Categorie di costo/ricavo (usa get_categories)
- Centri di costo con struttura gerarchica (usa get_cost_centers)
- Articoli/prodotti con tonnellate e fatturato (usa get_articles)
- Impostazioni aziendali e conti bancari (usa get_company_settings)
- Statistiche riconciliazione (usa get_reconciliation_stats)
- Classificazioni e suggerimenti AI

Quando l'utente chiede dove classificare una spesa, consulta il piano dei conti e le categorie DELL'AZIENDA, non rispondere in modo generico. Usa get_chart_of_accounts per trovare il conto giusto.

Quando l'utente chiede informazioni, usa le funzioni per recuperare dati reali. Non inventare mai dati. Per importi usa il formato italiano (1.234,56 €). Quando analizzi movimenti bancari, presta particolare attenzione al campo raw_text e extracted_refs per trovare riferimenti a fatture, mandati, contratti, rate.

CONVENZIONE DIRECTION (MOLTO IMPORTANTE):
- direction='out' = Fattura ATTIVA (emessa da noi, vendita) → denaro IN ENTRATA. Nel campo direction dei risultati, "out" significa fattura attiva/emessa.
- direction='in' = Fattura PASSIVA (ricevuta, acquisto) → denaro IN USCITA. Nel campo direction dei risultati, "in" significa fattura passiva/ricevuta.
- Quando presenti i risultati, traduci SEMPRE: direction='out' → "Attiva", direction='in' → "Passiva". MAI il contrario.

STRATEGIA DI RICERCA FATTURE — IMPORTANTE:
- Per filtri strutturati (controparte, data, importo, tipo doc): usa get_invoices
- IMPORTANTE: Quando l'utente cerca fatture per CONTENUTO (prodotti, materiali, articoli, descrizioni, servizi, codici, CIG, CUP, keywords), usa SEMPRE il tool search_invoices. Questo tool cerca anche nelle RIGHE FATTURA (invoice_lines.description) e nel riassunto AI (extracted_summary). Il tool get_invoices NON cerca nelle descrizioni delle righe fattura.
- Esempi di quando usare search_invoices: "fatture con calcare", "fatture pietrisco", "forniture cemento", "fattura con CIG...", "chi ha fatturato per trasporti", "fatture relative a manutenzione"
- Per dettaglio singola fattura con extracted_summary AI: usa get_invoice_detail
- Se search_invoices ritorna 0 risultati, prova con parole chiave diverse o più corte (es. "calcar" invece di "calcare", "pietr" invece di "pietrisco")

STRUMENTI PER ANALISI RIGHE FATTURA — REGOLE CRITICHE:
- Per SOMME e AGGREGATI (tonnellate totali, fatturato totale, prezzo medio, andamento mensile): usa SEMPRE aggregate_invoice_lines. Questo esegue una query SQL aggregata diretta — NON caricare tutte le fatture per poi sommare.
- Per ESPLORARE quali prodotti/servizi esistono per una controparte o periodo: usa get_distinct_line_descriptions. Ritorna una riga per descrizione unica con conteggi e totali.
- Per ANALISI DETTAGLIATA delle righe di molte fatture (es. "mostrami le ultime 20 fatture con le righe"): usa get_invoices_with_lines. Carica fino a 50 fatture con le righe in una singola query.
- NON chiamare MAI get_invoice_detail in loop per più di 3 fatture. Usa get_invoices_with_lines al suo posto.
- Esempi:
  * "quante tonnellate di calcare nel 2025?" → aggregate_invoice_lines(line_description="calcare", date_from="2025-01-01", date_to="2025-12-31", group_by="none")
  * "fatturato mensile per Buzzi" → aggregate_invoice_lines(counterparty="Buzzi", group_by="month")
  * "prezzo medio calcare per Buzzi" → aggregate_invoice_lines(counterparty="Buzzi", line_description="calcare", group_by="none")
  * "che prodotti fatturiamo a Buzzi?" → get_distinct_line_descriptions(counterparty="Buzzi", direction="out")
  * "mostra le ultime fatture con righe per trasporto" → get_invoices_with_lines(line_description="trasporto")

CONTROPARTI: get_counterparties supporta ordinamento per fatturato, credito o debito (order_by). Usa role per filtrare clienti/fornitori. Supporta date_from/date_to per statistiche nel periodo.

STATISTICHE: get_company_stats ora include saldo_banca e top 5 clienti/fornitori per fatturato. Supporta filtri date per periodo specifico.

Hai anche accesso alla Knowledge Base aziendale tramite search_knowledge_base. Se l'utente chiede informazioni su documenti caricati (contratti, regolamenti, procedure, manuali), cerca prima nella knowledge base.

CLASSIFICAZIONE FATTURE:
- get_classification_stats: per statistiche su quante fatture sono classificate, breakdown per categoria/CdC/conto. Usa per domande tipo "quante fatture sono classificate?", "distribuzione per categoria", "stato classificazione".
- classify_invoice: per classificare automaticamente fatture specifiche (max 10). Usa matching deterministico + AI Haiku. Input: invoice_ids. Usa quando l'utente dice "classifica questa fattura", "classifica le fatture di [controparte]".
- get_invoices con filtro classified=false: per trovare fatture da classificare.
- get_invoices con filtro category_name o cost_center_code: per trovare fatture classificate con categoria/CdC specifico.
- get_company_stats include sezione "classificazione" con conteggi fatture classificate/AI/non classificate.

ISTRUZIONI UTENTE (MEMORIA PERSISTENTE) — OBBLIGATORIO:
REGOLA CRITICA: quando l'utente dice "ricordati", "ricorda che", "memorizza", "salva questa regola", o dichiara una REGOLA, PREFERENZA o CONVENZIONE che deve essere ricordata per il futuro, DEVI OBBLIGATORIAMENTE chiamare il tool save_user_instruction. NON rispondere MAI solo con testo tipo "Memorizzato" senza aver effettivamente chiamato il tool. Se non chiami il tool, l'istruzione NON viene salvata e l'utente perde la regola.
- save_user_instruction: chiama SEMPRE questo tool per salvare regole utente. Esempi:
  * "le fatture CREDEMLEASING sono sempre leasing veicoli" → scope: counterparty
  * "il calcare va classificato come materia prima" → scope: classification
  * "i pagamenti F24 non vanno riconciliati" → scope: reconciliation
  * "usa sempre il centro di costo BRE-FRA per il frantoio" → scope: general
  * "ricordati che Goldenergy è sempre energia elettrica" → scope: counterparty
- get_user_instructions: per mostrare le regole salvate o verificare se ne esiste già una simile
- Le istruzioni salvate vengono automaticamente iniettate nel contesto di tutte le future classificazioni AI e sessioni chat
- RIPETO: è VIETATO dire "memorizzato/salvato/ricordato" senza aver chiamato save_user_instruction. Chiama PRIMA il tool, POI conferma all'utente.

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
  thinkingEnabled = false,
  extraSystemContext = "",
): Promise<{ content: string; thinking?: string; toolCalls: ToolCallInfo[]; tokensUsed: number }> {
  let currentMessages = [...messages];
  const allToolCalls: ToolCallInfo[] = [];
  let totalTokens = 0;
  let thinkingText = "";

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  // Build request body differently for thinking vs normal mode
  const fullSystemPrompt = extraSystemContext
    ? `${SYSTEM_PROMPT}\n\n${extraSystemContext}`
    : SYSTEM_PROMPT;

  function buildRequestBody() {
    if (thinkingEnabled) {
      // Extended Thinking: no system top-level, no temperature, thinking budget
      // Prepend system prompt as first user message context
      const thinkingMessages = [...currentMessages];
      if (thinkingMessages.length > 0 && thinkingMessages[0].role === "user") {
        thinkingMessages[0] = {
          role: "user",
          content: `[Contesto sistema]\n${fullSystemPrompt}\n\n[Domanda utente]\n${thinkingMessages[0].content}`,
        };
      }
      return {
        model,
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: thinkingMessages,
        tools,
      };
    }
    return {
      model,
      max_tokens: 4096,
      system: fullSystemPrompt,
      messages: currentMessages,
      tools,
    };
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildRequestBody()),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${clip(err, 300)}`);
    }

    const data = await response.json();
    totalTokens += (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    // Collect thinking blocks (Extended Thinking mode)
    const thinkingBlocks = (data.content || []).filter(
      (b: { type: string }) => b.type === "thinking",
    );
    for (const tb of thinkingBlocks) {
      if (tb.thinking) thinkingText += (thinkingText ? "\n\n" : "") + tb.thinking;
    }

    const toolUseBlocks = (data.content || []).filter(
      (b: { type: string }) => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const textBlock = (data.content || []).find(
        (b: { type: string }) => b.type === "text",
      );
      return {
        content: textBlock?.text || "Non ho trovato una risposta.",
        thinking: thinkingText || undefined,
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

    const modelPreference = String(body.model_preference || "fast");
    const chatModel = modelPreference === "thinking" ? THINKING_MODEL : HAIKU_MODEL;

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

    // Load shared accounting context + user instructions
    const companyRow = await sql`
      SELECT name, vat_number FROM companies WHERE id = ${companyId} LIMIT 1
    `;
    const companyContext: CompanyContext | undefined = companyRow.length > 0
      ? {
          company_name: companyRow[0].name,
          sector: 'servizi',
          vat_number: companyRow[0].vat_number,
        }
      : undefined;

    const accountingPrompt = getAccountingSystemPrompt(companyContext);
    const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);

    const instructionsContext = [
      `COMPETENZE CONTABILI DI BASE:\n${accountingPrompt}`,
      userInstructionsBlock,
    ].filter(Boolean).join("\n\n");

    // Run AI (model based on user preference: fast=haiku, thinking=sonnet with extended thinking)
    const isThinking = modelPreference === "thinking";
    const result = await runAiChat(claudeMessages, sql, companyId, chatModel, isThinking, instructionsContext);

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
      VALUES (${chatId}, 'assistant', ${result.content}, ${result.tokensUsed}, ${chatModel})
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
      message: { role: "assistant", content: result.content, thinking: result.thinking || null },
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
