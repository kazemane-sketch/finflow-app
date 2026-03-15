// classify-v2-classify — Stage B: Classification with Function Calling
// Commercialista AI classifies ALL invoice lines in ONE call.
// Uses 7 tools on-demand instead of preloading all context into the prompt.
// Supports any model (Gemini, OpenAI, Claude) configured in agent_config.
//
// Tools: cerca_conti, get_defaults_conto, storico_controparte,
//        get_tax_codes, get_parametro_fiscale, get_profilo_controparte, consulta_kb

import postgres from "npm:postgres@3.4.5";

import { callLLMWithTools, resolveAgentConfig, type ToolDeclaration } from "../_shared/llm-caller.ts";
import { handleWebSearch, WEB_SEARCH_TOOL_DECLARATION } from "../_shared/web-search.ts";
import { callGeminiEmbedding, toVectorLiteral } from "../_shared/embeddings.ts";
import { loadKbAdvisoryContext } from "../_shared/kb-advisory.ts";
import { extractJson } from "../_shared/json-helpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Types ──────────────────────────────── */

interface InputLine {
  line_id: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  vat_rate: number | null;
  vat_nature: string | null;
  iva_importo: number | null;
  matched_groups: string[];
}

interface ExactMatchEvidence {
  line_id: string;
  source: "rule" | "history";
  confidence: number;
  reasoning: string;
  category_id: string | null;
  account_id: string | null;
  article_id?: string | null;
  phase_id?: string | null;
}

interface FiscalOutput {
  iva_detraibilita_pct: number;
  deducibilita_ires_pct: number;
  irap_mode: string;
  irap_pct?: number;
  ritenuta_applicabile: boolean;
  ritenuta_tipo?: string;
  ritenuta_aliquota_pct?: number;
  ritenuta_base_pct?: number;
  cassa_previdenziale_pct?: number;
  reverse_charge: boolean;
  split_payment: boolean;
  bene_strumentale: boolean;
  asset_candidate: boolean;
  asset_category_guess?: string;
  ammortamento_aliquota_proposta?: number;
  debt_related: boolean;
  debt_type?: string;
  competenza_dal?: string;
  competenza_al?: string;
  costo_personale: boolean;
  warning_flags: string[];
  fiscal_reasoning_short: string;
}

interface LineProposal {
  line_id: string;
  account_code: string | null;
  account_id: string | null;
  category_id: string | null;
  confidence: number;
  reasoning: string;
  fiscal: FiscalOutput;
  doubts: { question: string; impact: string }[];
}

interface CommercialistaResponse {
  invoice_summary: string;
  needs_consultant: boolean;
  consultant_reason: string | null;
  lines: LineProposal[];
}

interface AgentConfig {
  system_prompt: string;
  model: string;
  temperature: number;
  thinking_budget: number | null;
  thinking_effort: string | null;
  max_output_tokens: number;
  react_mode?: boolean;
  web_search_enabled?: boolean;
}

/* ─── Tool Declarations ──────────────────── */

const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "cerca_conti",
    description: "Cerca conti nel piano dei conti dell'azienda per parole chiave, codice, sezione, o riferimenti strutturati del documento. Se hai un riferimento utile (contratto, polizza, pratica, mandato, targa, numero ratea/posizione), passalo per trovare conti specifici o numerati coerenti.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Parole chiave: es. 'leasing', 'carburante', 'telefonia'" },
        section: { type: "STRING", description: "Opzionale. Filtra per sezione: cost_production, financial, other_costs, revenue, assets, liabilities" },
        context_text: { type: "STRING", description: "Opzionale. Testo completo della riga o estratto della fattura: il tool può ricavare da qui riferimenti utili oltre alla natura economica." },
        reference_hint: { type: "STRING", description: "Opzionale. Riferimento strutturato dalla fattura o dal documento (es. '01499014/001', 'AV275477', 'mandato 12345'). Il tool estrarrà i pattern utili per cercare conti specifici." },
        contract_ref: { type: "STRING", description: "Compatibilità legacy: usa reference_hint. Puoi comunque passare qui un riferimento strutturato dalla fattura." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_defaults_conto",
    description: "Legge i default fiscali di un conto specifico: tax_code, IRES%, IRAP mode, needs_user_confirmation, note_fiscali.",
    parameters: {
      type: "OBJECT",
      properties: {
        account_code: { type: "STRING", description: "Codice del conto (es. '61.20.010')" },
      },
      required: ["account_code"],
    },
  },
  {
    name: "storico_controparte",
    description: "Cerca classificazioni confermate per questa controparte. Mostra descrizione, conto, categoria e frequenza.",
    parameters: {
      type: "OBJECT",
      properties: {
        description_hint: { type: "STRING", description: "Parole chiave opzionali per filtrare le righe dello storico (es. 'canone', 'manutenzione')" },
        contract_ref: { type: "STRING", description: "Opzionale: numero contratto dalla fattura per matching esatto" },
      },
    },
  },
  {
    name: "get_tax_codes",
    description: "Cerca codici IVA disponibili. Filtra per aliquota, tipo (acquisto/vendita/entrambi) o natura.",
    parameters: {
      type: "OBJECT",
      properties: {
        aliquota: { type: "NUMBER", description: "Aliquota IVA (es. 22, 10, 4)" },
        tipo: { type: "STRING", description: "Tipo: acquisto, vendita, entrambi" },
        natura: { type: "STRING", description: "Natura IVA (es. N1, N2.1, N6.1)" },
      },
    },
  },
  {
    name: "get_parametro_fiscale",
    description: "Cerca parametri normativi fiscali: soglie, aliquote, limiti di deducibilità. Filtra per codice, categoria o parola chiave.",
    parameters: {
      type: "OBJECT",
      properties: {
        codice: { type: "STRING", description: "Codice parametro specifico (es. 'art_164_auto_promiscua_deduc')" },
        categoria: { type: "STRING", description: "Categoria: ires, iva, irap, ritenute, cespiti, soglie, bollo" },
        query: { type: "STRING", description: "Ricerca testuale nel nome/normativa" },
      },
    },
  },
  {
    name: "get_profilo_controparte",
    description: "Legge il profilo fiscale della controparte: tipo soggetto, ritenuta, cassa previdenziale, split payment, paese.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
  {
    name: "consulta_kb",
    description: "Cerca nella knowledge base aziendale note consultive e fonti normative. Usa per casi fiscalmente complessi (leasing, auto, reverse charge, ritenute, cespiti).",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Domanda o argomento da cercare nella KB (es. 'deducibilità auto promiscua SRL', 'reverse charge servizi edili')" },
      },
      required: ["query"],
    },
  },
  {
    name: "valida_classificazione_proposta",
    description: "OBBLIGATORIO prima del JSON finale. Invia le tue proposte per una validazione automatica: verifica che i conti esistano, che i fiscal flags siano coerenti, e segnala problemi. Correggi i problemi trovati prima di emettere il JSON finale.",
    parameters: {
      type: "OBJECT",
      properties: {
        proposte_righe: {
          type: "ARRAY",
          description: "Array di proposte di classificazione da validare",
          items: {
            type: "OBJECT",
            properties: {
              line_id: { type: "STRING" },
              account_code: { type: "STRING", description: "Codice conto proposto" },
              description: { type: "STRING", description: "Descrizione della riga" },
              confidence: { type: "INTEGER" },
              iva_detraibilita_pct: { type: "INTEGER" },
              deducibilita_ires_pct: { type: "INTEGER" },
              ritenuta_applicabile: { type: "BOOLEAN" },
              reverse_charge: { type: "BOOLEAN" },
              bene_strumentale: { type: "BOOLEAN" },
              asset_nature_confirmed: { type: "BOOLEAN", description: "true se hai evidenza diretta dalla fattura sulla natura del bene" },
              debt_related: { type: "BOOLEAN" },
            },
            required: ["line_id", "account_code"],
          },
        },
      },
      required: ["proposte_righe"],
    },
  },
];

/* ─── Normalize AI output (handles both flat and wrapped formats) ─── */

function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Unwrap { value: X, state: "..." } → X */
function unwrap(val: unknown): unknown {
  if (val && typeof val === "object" && "value" in (val as Record<string, unknown>)) {
    return (val as Record<string, unknown>).value;
  }
  return val;
}

interface NormalizedFiscal {
  iva_detraibilita_pct: number;
  deducibilita_ires_pct: number;
  irap_mode: string;
  irap_pct?: number;
  ritenuta_applicabile: boolean;
  ritenuta_tipo?: string;
  ritenuta_aliquota_pct?: number;
  ritenuta_base_pct?: number;
  cassa_previdenziale_pct?: number;
  reverse_charge: boolean;
  split_payment: boolean;
  bene_strumentale: boolean;
  asset_candidate: boolean;
  asset_category_guess?: string;
  ammortamento_aliquota_proposta?: number;
  debt_related: boolean;
  debt_type?: string;
  interest_amount?: number;
  principal_amount?: number;
  competenza_dal?: string;
  competenza_al?: string;
  costo_personale: boolean;
  warning_flags: string[];
  fiscal_reasoning_short: string;
}

interface NormalizedLineProposal {
  line_id: string;
  account_code: string | null;
  account_id: string | null;
  category_id: string | null;
  confidence: number;
  reasoning: string;
  rationale_summary: string;
  decision_basis: string[];
  supporting_factors: string[];
  fiscal: NormalizedFiscal;
  doubts: { question: string; impact: string }[];
}

function normalizeFiscal(raw: Record<string, unknown>): NormalizedFiscal {
  return {
    iva_detraibilita_pct: Number(unwrap(raw.iva_detraibilita_pct ?? raw.vat_deductibility_percent) ?? 100),
    deducibilita_ires_pct: Number(unwrap(raw.deducibilita_ires_pct ?? raw.ires_deductibility_percent) ?? 100),
    irap_mode: String(unwrap(raw.irap_mode) || "follows_ires"),
    irap_pct: raw.irap_pct != null ? Number(unwrap(raw.irap_pct)) : undefined,
    ritenuta_applicabile: Boolean(unwrap(raw.ritenuta_applicabile)),
    ritenuta_tipo: (unwrap(raw.ritenuta_tipo) as string) || undefined,
    ritenuta_aliquota_pct: raw.ritenuta_aliquota_pct != null ? Number(unwrap(raw.ritenuta_aliquota_pct)) : undefined,
    ritenuta_base_pct: raw.ritenuta_base_pct != null ? Number(unwrap(raw.ritenuta_base_pct)) : undefined,
    cassa_previdenziale_pct: raw.cassa_previdenziale_pct != null ? Number(unwrap(raw.cassa_previdenziale_pct)) : undefined,
    reverse_charge: Boolean(unwrap(raw.reverse_charge)),
    split_payment: Boolean(unwrap(raw.split_payment)),
    bene_strumentale: Boolean(unwrap(raw.bene_strumentale)),
    asset_candidate: Boolean(unwrap(raw.asset_candidate)),
    asset_category_guess: (unwrap(raw.asset_category_guess) as string) || undefined,
    ammortamento_aliquota_proposta: raw.ammortamento_aliquota_proposta != null ? Number(unwrap(raw.ammortamento_aliquota_proposta)) : undefined,
    debt_related: Boolean(unwrap(raw.debt_related)),
    debt_type: (unwrap(raw.debt_type) as string) || undefined,
    interest_amount: raw.interest_amount != null ? Number(unwrap(raw.interest_amount)) : undefined,
    principal_amount: raw.principal_amount != null ? Number(unwrap(raw.principal_amount)) : undefined,
    competenza_dal: (unwrap(raw.competenza_dal) as string) || undefined,
    competenza_al: (unwrap(raw.competenza_al) as string) || undefined,
    costo_personale: Boolean(unwrap(raw.costo_personale)),
    warning_flags: Array.isArray(raw.warning_flags) ? raw.warning_flags.map(String) : [],
    fiscal_reasoning_short: String(unwrap(raw.fiscal_reasoning_short ?? raw.rationale) || ""),
  };
}

function normalizeLineProposal(raw: Record<string, unknown>): NormalizedLineProposal {
  // unwrap() handles both plain values and wrapped { value: X, state: "..." } objects
  // Account: { account_code: "X" } or { account: { value: "X", state: "..." } }
  let account_code: string | null = null;
  let account_id: string | null = null;
  const rawAccountCode = unwrap(raw.account_code);
  const rawAccountId = unwrap(raw.account_id);
  if (rawAccountCode) {
    account_code = String(rawAccountCode);
  } else if ((raw.account as any)?.value) {
    account_code = String((raw.account as any).value);
  }
  if (rawAccountId) {
    const strId = String(rawAccountId);
    // Guard: only accept actual UUIDs or account codes, never "[object Object]"
    if (strId !== "[object Object]") {
      account_id = strId;
    }
  }
  if (!account_id && account_code && isUUID(account_code)) {
    account_id = account_code;
    account_code = null;
  }

  // Category: { category_id: "uuid" } or { category: { value: "uuid" } }
  let category_id: string | null = null;
  const rawCategoryId = unwrap(raw.category_id);
  if (rawCategoryId) {
    const strCat = String(rawCategoryId);
    if (strCat !== "[object Object]") {
      category_id = strCat;
    }
  } else if ((raw.category as any)?.value) {
    category_id = String((raw.category as any).value);
  }

  const confidence = Number(unwrap(raw.confidence) || 0);
  const rawReasoning = unwrap(raw.reasoning);
  const rawRationale = unwrap(raw.rationale_summary);
  const reasoning = String(rawReasoning || rawRationale || "");

  // Fiscal: { fiscal: {...} } or { fiscal_flags: { tax_code: { value: "22" }, ... } }
  const fiscal = normalizeFiscal((raw.fiscal || raw.fiscal_flags || {}) as Record<string, unknown>);

  const doubts: { question: string; impact: string }[] = Array.isArray(raw.doubts)
    ? raw.doubts.map((d: any) => ({ question: d.question || "", impact: d.impact || "" }))
    : [];

  const supporting_factors = Array.isArray(raw.supporting_factors) ? raw.supporting_factors.map(String) : [];
  const decision_basis = raw.decision_basis
    ? (Array.isArray(raw.decision_basis) ? raw.decision_basis.map(String) : [String(raw.decision_basis)])
    : [];

  return {
    line_id: String(unwrap(raw.line_id) || ""),
    account_code,
    account_id,
    category_id,
    confidence,
    reasoning,
    rationale_summary: String(rawRationale || reasoning),
    decision_basis,
    supporting_factors,
    fiscal,
    doubts,
  };
}

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const openaiKey = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);
  if (!geminiKey && !anthropicKey && !openaiKey) return json({ error: "Nessuna API key configurata (GEMINI/ANTHROPIC/OPENAI)" }, 503);

  let body: {
    company_id?: string;
    invoice_id?: string;
    lines?: InputLine[];
    deterministic_matches?: ExactMatchEvidence[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
    invoice_notes?: string;
    invoice_causale?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const deterministicMatches = body.deterministic_matches || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const invoiceNotes = body.invoice_notes || null;
  const invoiceCausale = body.invoice_causale || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 3 });

  try {
    // ─── Load minimal context (company, counterparty, invoice, agent config) ──────
    const [companyRow, invoiceRow, counterpartyRow, agentConfigs] = await Promise.all([
      sql`SELECT name, vat_number, ateco_code, ateco_description, fiscal_regime, iva_per_cassa
          FROM companies WHERE id = ${companyId} LIMIT 1`,
      sql`SELECT total_amount, taxable_amount, tax_amount, withholding_amount, stamp_amount,
                 date, doc_type, direction, notes, raw_xml, number, primary_contract_ref, contract_refs
          FROM invoices WHERE id = ${invoiceId} LIMIT 1`,
      counterpartyVatKey
        ? sql`SELECT name, vat_number, fiscal_code, legal_type, ateco_code, ateco_description,
                     tipo_soggetto, soggetto_a_ritenuta, cassa_previdenziale, split_payment_soggetto,
                     paese_residenza, business_sector
              FROM counterparties
              WHERE company_id = ${companyId}
                AND vat_key = ${counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "")}
              LIMIT 1`
        : Promise.resolve([]),
      sql<AgentConfig[]>`
        SELECT system_prompt, model, temperature, thinking_budget, thinking_effort, max_output_tokens, react_mode, web_search_enabled
        FROM agent_config WHERE active = true AND agent_type = 'commercialista'
        LIMIT 1`,
    ]);

    const company = companyRow[0];
    const invoice = invoiceRow[0];
    const counterparty = counterpartyRow[0] || null;
    const agentConfig = agentConfigs[0] || null;

    if (!company) return json({ error: "Company non trovata" }, 404);
    if (!invoice) return json({ error: "Invoice non trovata" }, 404);

    // ─── Build system prompt ──────
    let systemPrompt = agentConfig?.system_prompt || `Sei un commercialista italiano senior specializzato in PMI.

COMPITO: Classifica ogni riga della fattura. Per ciascuna:
1. Cerca il conto giusto nel piano dei conti (tool: cerca_conti)
2. Verifica lo storico della controparte (tool: storico_controparte)
3. Determina IVA, deducibilità IRES, IRAP, ritenute, competenza, cespiti
4. Se la riga è fiscalmente complessa (leasing, auto, RC), consulta la KB
5. Se hai dubbi, segnalali — MAI tirare a indovinare

METODO:
- USA I TOOL per cercare conti, storico, parametri. Non indovinare.
- Se non trovi abbastanza evidenze, segnala un dubbio — mai tirare a indovinare.
- Se il conto ha needs_user_confirmation=true, genera un dubbio.
- Percentuali: SEMPRE numeri 0-100.
- PRIMA di emettere il JSON finale, USA il tool valida_classificazione_proposta per verificare che i conti esistano e i parametri fiscali siano coerenti. Correggi i problemi segnalati.`;

    if (agentConfig?.react_mode) {
      systemPrompt += `\n\n[MODALITÀ REACT ATTIVA]: Stai operando in modalità ReAct (Reasoning + Acting). Prima di terminare e fornire il JSON finale, DEVI obbligatoriamente usare il tool 'stendi_bozza_e_fai_autocritica' per le righe incerte o complesse (es. contratti, leasing, assicurazioni). Questo tool non ti darà validazioni esterne: serve a te per mettere per iscritto la tua ipotesi, giustificarla e, soprattutto, trovare possibili falle o assunzioni non provate (es. basate solo sull'ATECO) prima di prendere la decisione finale. Solo dopo esserti auto-criticato potrai emettere la classificazione JSON definitiva.`;
    }

    // ─── Build user prompt with full invoice data ──────
    const exactMatchMap = new Map(deterministicMatches.map((m) => [m.line_id, m]));

    const linesText = lines.map((l, i) => {
      const exactMatch = exactMatchMap.get(l.line_id);
      const exactCtx = exactMatch
        ? `\n   EVIDENZA DETERMINISTICA: source=${exactMatch.source} conf=${exactMatch.confidence} "${exactMatch.reasoning}"`
        : "";
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}"
   Qtà: ${l.quantity ?? "N/D"}, P.Unit: €${l.unit_price ?? "N/D"}, Imponibile: €${l.total_price ?? "N/D"}, IVA: ${l.vat_rate ?? "N/D"}%, Natura: ${l.vat_nature || "N/D"}, IVA importo: €${l.iva_importo ?? "N/D"}${exactCtx}`;
    }).join("\n");

    const cpInfo = counterparty
      ? `${counterparty.name || counterpartyName} (P.IVA: ${counterparty.vat_number || "N/D"})
Tipo: ${counterparty.tipo_soggetto || counterparty.legal_type || "N/D"} | ATECO: ${counterparty.ateco_code || "N/D"} ${counterparty.ateco_description || ""}
Ritenuta: ${counterparty.soggetto_a_ritenuta ? "SI" : "NO"} | Cassa: ${counterparty.cassa_previdenziale || "NO"} | Split: ${counterparty.split_payment_soggetto ? "SI" : "NO"} | Paese: ${counterparty.paese_residenza || "IT"}`
      : `${counterpartyName} (P.IVA: ${counterpartyVatKey || "N/D"})`;

    const userPrompt = `FATTURA DA CLASSIFICARE:
Numero: ${invoice.number || "N/D"} | Data: ${invoice.date || "N/D"} | Tipo: ${invoice.doc_type || "N/D"}
Direzione: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
Totale: €${invoice.total_amount || "N/D"} | Imponibile: €${invoice.taxable_amount || "N/D"} | IVA: €${invoice.tax_amount || "N/D"}
Ritenuta: €${invoice.withholding_amount || 0} | Bollo: €${invoice.stamp_amount || 0}
${invoice.primary_contract_ref ? `Rif. Contratto: ${invoice.primary_contract_ref}\n` : ''}${invoice.contract_refs && Array.isArray(invoice.contract_refs) && invoice.contract_refs.length > 0 ? `Riferimenti aggiuntivi: ${JSON.stringify(invoice.contract_refs)}\n` : ''}${invoiceNotes ? `Note: ${invoiceNotes}` : ""}${invoiceCausale ? ` | Causale XML: ${invoiceCausale}` : ""}

CONTROPARTE:
${cpInfo}

AZIENDA:
${company.name} (P.IVA: ${company.vat_number || "N/D"})
ATECO: ${company.ateco_code || "N/D"} ${company.ateco_description || ""} | Regime: ${company.fiscal_regime || "ordinario"} | IVA per cassa: ${company.iva_per_cassa ? "SI" : "NO"}

RIGHE:
${linesText}

ISTRUZIONI:
USA I TOOL per cercare conti, storico, KB. Ragiona. Se una riga o il documento contengono riferimenti specifici, puoi cercare i conti usando sia la natura economica sia quei riferimenti, anche passando il testo completo in context_text se ti aiuta. Poi rispondi JSON.

OUTPUT (JSON, no markdown):
{
  "invoice_summary": "...",
  "needs_consultant": false,
  "consultant_reason": null,
  "lines": [{
    "line_id": "uuid",
    "account_code": "...",
    "account_id": "uuid",
    "category_id": "uuid"|null,
    "confidence": 85,
    "reasoning": "...",
    "fiscal": {
      "iva_detraibilita_pct": 100,
      "deducibilita_ires_pct": 100,
      "irap_mode": "follows_ires",
      "ritenuta_applicabile": false,
      "reverse_charge": false,
      "split_payment": false,
      "bene_strumentale": false,
      "asset_candidate": false,
      "debt_related": false,
      "costo_personale": false,
      "warning_flags": [],
      "fiscal_reasoning_short": "..."
    },
    "doubts": [{"question": "...", "impact": "..."}]
  }]
}`;

    // ─── Build tool handler ──────
    const companyAteco = company.ateco_code || "";

    async function toolHandler(name: string, args: Record<string, unknown>): Promise<unknown> {
      switch (name) {
        case "cerca_conti": {
          const query = String(args.query || "").trim();
          const section = args.section ? String(args.section) : null;
          const contextText = String(args.context_text || "").trim();
          const sectionFilter = section ? sql`AND section = ${section}` : sql``;
          const implicitReferenceHints = [
            invoice.primary_contract_ref ? String(invoice.primary_contract_ref) : "",
            ...(Array.isArray(invoice.contract_refs) ? invoice.contract_refs.map((value) => String(value || "")) : []),
          ].map((value) => value.trim()).filter(Boolean);
          
          // Query 1: ILIKE + trigram (sempre)
          const rows = await sql`
            SELECT id, code, name, section,
                   default_tax_code_id, default_ires_pct,
                   default_irap_mode, needs_user_confirmation, note_fiscali,
                   GREATEST(
                     CASE WHEN name ILIKE ${'%' + query + '%'} OR code ILIKE ${'%' + query + '%'} THEN 0.9 ELSE 0 END,
                     word_similarity(${query}, name)
                   ) AS relevance
            FROM chart_of_accounts
            WHERE company_id = ${companyId} AND active = true AND is_header = false
              ${sectionFilter}
              AND (
                name ILIKE ${'%' + query + '%'}
                OR code ILIKE ${'%' + query + '%'}
                OR word_similarity(${query}, name) > 0.15
              )
            ORDER BY relevance DESC, code
            LIMIT 15`;

          // Query 2: numeric pattern search (solo se ci sono numeri nella query)
          const numericPatterns = ([query, contextText].join(" ").match(/\d{4,}/g) || [])
            .map(n => n.replace(/^0+/, ''))
            .filter(n => n.length >= 4);
          const structuredPatterns: string[] = [];

          // Se esiste un riferimento strutturato esplicito o implicito dalla fattura, usalo come pista
          for (const ref of [
            contextText,
            args.reference_hint ? String(args.reference_hint) : "",
            args.contract_ref ? String(args.contract_ref) : "",
            ...implicitReferenceHints,
          ].filter(Boolean)) {
            const normalizedRef = String(ref).trim().toUpperCase();
            const compactRef = normalizedRef.replace(/[^A-Z0-9]/g, '');
            if (compactRef.length >= 5 && /\d/.test(compactRef)) {
              structuredPatterns.push(compactRef);
            }
            const contractNums = (String(ref).match(/\d{4,}/g) || [])
              .map((n: string) => n.replace(/^0+/, ''))
              .filter((n: string) => n.length >= 4);
            numericPatterns.push(...contractNums);
          }
          const uniqueNumericPatterns = Array.from(new Set(numericPatterns));
          const uniqueStructuredPatterns = Array.from(new Set(structuredPatterns));

          for (const row of rows) {
            const haystack = `${row.code || ''} ${row.name || ''}`;
            const compactHaystack = haystack.toUpperCase().replace(/[^A-Z0-9]/g, '');
            const numericHaystack = haystack.replace(/\D/g, '');
            const queryMatch =
              haystack.toLowerCase().includes(query.toLowerCase())
              || String(row.code || '').toLowerCase().includes(query.toLowerCase());
            const structuredMatch = uniqueStructuredPatterns.some((pattern) => compactHaystack.includes(pattern));
            const numericMatch = uniqueNumericPatterns.some((pattern) => numericHaystack.includes(pattern));
            if (queryMatch && (structuredMatch || numericMatch)) row.relevance = Math.max(row.relevance || 0, 0.99);
            else if (structuredMatch || numericMatch) row.relevance = Math.max(row.relevance || 0, 0.74);
          }
          
          let numericRows: any[] = [];
          if (uniqueNumericPatterns.length > 0 || uniqueStructuredPatterns.length > 0) {
            const numericConditions = uniqueNumericPatterns.map(n => `%${n}%`);
            const structuredConditions = uniqueStructuredPatterns.map(pattern => `%${pattern}%`);
            numericRows = await sql`
              SELECT id, code, name, section,
                     default_tax_code_id, default_ires_pct,
                     default_irap_mode, needs_user_confirmation, note_fiscali,
                     0.72::float AS relevance
              FROM chart_of_accounts
              WHERE company_id = ${companyId} AND active = true AND is_header = false
                ${sectionFilter}
                AND (
                  ${numericConditions.length > 0 ? sql`(name ILIKE ANY(${numericConditions}) OR code ILIKE ANY(${numericConditions}))` : sql`false`}
                  OR ${structuredConditions.length > 0 ? sql`(REPLACE(UPPER(name), ' ', '') ILIKE ANY(${structuredConditions}) OR REPLACE(UPPER(code), ' ', '') ILIKE ANY(${structuredConditions}))` : sql`false`}
                )
              ORDER BY code
              LIMIT 15`;
          }

          // Merge e deduplica
          const seen = new Set(rows.map((r: any) => r.id));
          const merged = [...rows];
          for (const nr of numericRows) {
            if (!seen.has(nr.id)) {
              const haystack = `${nr.code || ''} ${nr.name || ''}`;
              const numericHaystack = haystack.replace(/\D/g, '');
              const compactHaystack = haystack.toUpperCase().replace(/[^A-Z0-9]/g, '');
              const queryMatch =
                haystack.toLowerCase().includes(query.toLowerCase())
                || String(nr.code || '').toLowerCase().includes(query.toLowerCase());
              const numericMatch = uniqueNumericPatterns.some((pattern) => numericHaystack.includes(pattern));
              const structuredMatch = uniqueStructuredPatterns.some((pattern) => compactHaystack.includes(pattern));
              if (queryMatch && (numericMatch || structuredMatch)) nr.relevance = 0.99;
              else if (numericMatch || structuredMatch) nr.relevance = Math.max(nr.relevance || 0.72, 0.74);
              merged.push(nr);
              seen.add(nr.id);
            }
          }
          
          // Ordina per relevance e limita
          merged.sort((a: any, b: any) => (b.relevance || 0) - (a.relevance || 0));
          return merged.slice(0, 15);
        }

        case "get_defaults_conto": {
          const code = String(args.account_code || "");
          const [row] = await sql`
            SELECT id, code, name, section, default_tax_code_id, default_ires_pct,
                   default_irap_mode, default_irap_pct, needs_user_confirmation, note_fiscali,
                   tc.codice AS tax_code, tc.descrizione AS tax_desc, tc.aliquota AS tax_aliquota,
                   tc.detraibilita_pct AS tax_detraibilita
            FROM chart_of_accounts coa
            LEFT JOIN tax_codes tc ON coa.default_tax_code_id = tc.id
            WHERE coa.company_id = ${companyId} AND coa.code = ${code}
            LIMIT 1`;
          return row || { error: `Conto ${code} non trovato` };
        }

        case "storico_controparte": {
          if (!counterpartyVatKey) return { message: "Nessuna P.IVA controparte disponibile" };
          const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
          const hint = String(args.description_hint || "").trim();
          const contractRef = args.contract_ref ? String(args.contract_ref) : null;
          
          let contractHistory: any[] = [];
          if (contractRef) {
            contractHistory = await sql`
              SELECT il.description, c.name AS category_name, a.code AS account_code, a.name AS account_name, i.primary_contract_ref
              FROM invoice_lines il
              JOIN invoices i ON il.invoice_id = i.id
              LEFT JOIN categories c ON il.category_id = c.id
              LEFT JOIN chart_of_accounts a ON il.account_id = a.id
              WHERE i.company_id = ${companyId}
                AND i.primary_contract_ref = ${contractRef}
                AND i.classification_status = 'confirmed'
                AND il.account_id IS NOT NULL
              ORDER BY i.date DESC LIMIT 5`;
          }

          let rows;
          if (hint) {
            rows = await sql`
              SELECT il.description, c.name AS category_name, a.code AS account_code, a.name AS account_name,
                     count(*)::int AS count
              FROM invoice_lines il
              JOIN invoices i ON il.invoice_id = i.id
              LEFT JOIN categories c ON il.category_id = c.id
              LEFT JOIN chart_of_accounts a ON il.account_id = a.id
              WHERE i.company_id = ${companyId} AND i.direction = ${direction}
                AND i.counterparty_id = (SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${companyId} LIMIT 1)
                AND i.classification_status = 'confirmed'
                AND il.category_id IS NOT NULL
                AND il.description ILIKE ${'%' + hint + '%'}
              GROUP BY il.description, c.name, a.code, a.name
              ORDER BY count DESC LIMIT 10`;
          } else {
            rows = await sql`
              SELECT il.description, c.name AS category_name, a.code AS account_code, a.name AS account_name,
                     count(*)::int AS count
              FROM invoice_lines il
              JOIN invoices i ON il.invoice_id = i.id
              LEFT JOIN categories c ON il.category_id = c.id
              LEFT JOIN chart_of_accounts a ON il.account_id = a.id
              WHERE i.company_id = ${companyId} AND i.direction = ${direction}
                AND i.counterparty_id = (SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${companyId} LIMIT 1)
                AND i.classification_status = 'confirmed'
                AND il.category_id IS NOT NULL
              GROUP BY il.description, c.name, a.code, a.name
              ORDER BY count DESC LIMIT 15`;
          }
          const historyResult = rows.length > 0 ? rows : { message: "Nessuno storico confermato per questa controparte" };
          return { history: historyResult, contract_history: contractHistory.length > 0 ? contractHistory : undefined };
        }

        case "get_tax_codes": {
          const aliquota = args.aliquota != null ? Number(args.aliquota) : null;
          const tipo = args.tipo ? String(args.tipo) : null;
          const natura = args.natura ? String(args.natura) : null;
          let rows;
          if (natura) {
            rows = await sql`
              SELECT codice, descrizione, aliquota, detraibilita_pct, natura, tipo, normativa_ref
              FROM tax_codes WHERE (company_id IS NULL OR company_id = ${companyId}) AND is_active = true
                AND natura = ${natura}
              ORDER BY sort_order LIMIT 10`;
          } else if (aliquota != null && tipo) {
            rows = await sql`
              SELECT codice, descrizione, aliquota, detraibilita_pct, natura, tipo, normativa_ref
              FROM tax_codes WHERE (company_id IS NULL OR company_id = ${companyId}) AND is_active = true
                AND aliquota = ${aliquota} AND tipo IN (${tipo}, 'entrambi')
              ORDER BY sort_order LIMIT 10`;
          } else if (aliquota != null) {
            rows = await sql`
              SELECT codice, descrizione, aliquota, detraibilita_pct, natura, tipo, normativa_ref
              FROM tax_codes WHERE (company_id IS NULL OR company_id = ${companyId}) AND is_active = true
                AND aliquota = ${aliquota}
              ORDER BY sort_order LIMIT 10`;
          } else {
            rows = await sql`
              SELECT codice, descrizione, aliquota, detraibilita_pct, natura, tipo, normativa_ref
              FROM tax_codes WHERE (company_id IS NULL OR company_id = ${companyId}) AND is_active = true
              ORDER BY sort_order LIMIT 20`;
          }
          return rows;
        }

        case "get_parametro_fiscale": {
          const codice = args.codice ? String(args.codice) : null;
          const categoria = args.categoria ? String(args.categoria) : null;
          const query = args.query ? String(args.query) : null;
          const invoiceDate = invoice.date || new Date().toISOString().slice(0, 10);

          if (codice) {
            const [row] = await sql`
              SELECT codice, nome, categoria, valore_numerico, valore_testo, unita, normativa_ref, normativa_dettaglio
              FROM fiscal_parameters
              WHERE codice = ${codice} AND valido_dal <= ${invoiceDate}::date
                AND (valido_al IS NULL OR valido_al >= ${invoiceDate}::date)
              LIMIT 1`;
            return row || { error: `Parametro ${codice} non trovato o non valido alla data fattura` };
          }
          if (categoria) {
            return await sql`
              SELECT codice, nome, valore_numerico, valore_testo, unita, normativa_ref
              FROM fiscal_parameters
              WHERE categoria = ${categoria} AND valido_dal <= ${invoiceDate}::date
                AND (valido_al IS NULL OR valido_al >= ${invoiceDate}::date)
              ORDER BY codice LIMIT 15`;
          }
          if (query) {
            return await sql`
              SELECT codice, nome, valore_numerico, valore_testo, unita, normativa_ref
              FROM fiscal_parameters
              WHERE (nome ILIKE ${'%' + query + '%'} OR normativa_ref ILIKE ${'%' + query + '%'})
                AND valido_dal <= ${invoiceDate}::date
                AND (valido_al IS NULL OR valido_al >= ${invoiceDate}::date)
              ORDER BY codice LIMIT 10`;
          }
          return { error: "Specifica codice, categoria o query" };
        }

        case "get_profilo_controparte": {
          if (!counterparty) return { message: "Controparte non trovata nel database" };
          return {
            name: counterparty.name,
            vat_number: counterparty.vat_number,
            tipo_soggetto: counterparty.tipo_soggetto || counterparty.legal_type || null,
            ateco_code: counterparty.ateco_code,
            ateco_description: counterparty.ateco_description,
            soggetto_a_ritenuta: counterparty.soggetto_a_ritenuta || false,
            cassa_previdenziale: counterparty.cassa_previdenziale || null,
            split_payment_soggetto: counterparty.split_payment_soggetto || false,
            paese_residenza: counterparty.paese_residenza || "IT",
            business_sector: counterparty.business_sector || null,
          };
        }

        case "consulta_kb": {
          const kbQuery = String(args.query || "");
          if (!geminiKey) return { error: "GEMINI_API_KEY necessaria per embeddings KB" };
          try {
            const queryVec = await callGeminiEmbedding(geminiKey, kbQuery);
            const queryVecLiteral = toVectorLiteral(queryVec);
            const result = await loadKbAdvisoryContext(sql, {
              companyId,
              audience: "commercialista",
              queryVecLiteral,
              queryText: kbQuery,
              companyAteco,
              noteLimit: 3,
              chunkLimit: 3,
            });
            return {
              notes: result.notes.map((n) => ({
                title: n.title,
                short_answer: n.short_answer,
                source_refs: n.source_refs,
                numeric_facts: n.numeric_facts,
              })),
              chunks: result.chunks.map((c) => ({
                doc_title: c.doc_title,
                section_title: c.section_title || "",
                article_reference: c.article_reference || "",
                content: c.content.slice(0, 500),
              })),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[classify-v2] consulta_kb failed:", msg);
            return { error: `KB search failed: ${msg}` };
          }
        }

        case "valida_classificazione_proposta": {
          const proposta = args.proposte_righe as any[];
          if (!proposta || !Array.isArray(proposta)) {
            return { error: "parametro proposte_righe mancante o non array" };
          }

          const feedback: string[] = [];

          for (const p of proposta) {
            const issues: string[] = [];

            // 1. Verifica che il conto esista
            if (p.account_code) {
              const [acc] = await sql`
                SELECT id, code, name, needs_user_confirmation, default_ires_pct, note_fiscali
                FROM chart_of_accounts
                WHERE company_id = ${companyId} AND code = ${String(p.account_code)} AND active = true
                LIMIT 1`;
              if (!acc) {
                issues.push(`ERRORE: conto "${p.account_code}" NON ESISTE nel piano dei conti.`);
              } else {
                if (acc.needs_user_confirmation) {
                  issues.push(`ATTENZIONE: il conto ${acc.code} ha flag needs_user_confirmation=true. DEVI generare un dubbio.`);
                }
                if (acc.default_ires_pct != null && p.deducibilita_ires_pct != null
                     && Math.abs(acc.default_ires_pct - p.deducibilita_ires_pct) > 10) {
                  issues.push(`VERIFICA: il conto ${acc.code} ha default_ires_pct=${acc.default_ires_pct}%, tu proponi ${p.deducibilita_ires_pct}%. Giustifica la differenza.`);
                }
                if (acc.note_fiscali) {
                  issues.push(`NOTA FISCALE del conto: "${acc.note_fiscali}". Verifica compatibilità.`);
                }
              }
            } else {
              issues.push(`ATTENZIONE: nessun conto proposto per questa riga. Se non sei sicuro, usa confidence bassa e genera un dubbio.`);
            }

            // 2. Verifica coerenza bene_strumentale
            if (p.bene_strumentale === true && !p.asset_nature_confirmed) {
              issues.push(`ATTENZIONE: hai marcato bene_strumentale=true ma la natura del bene NON è stata confermata dalla fattura. DEVI generare un dubbio sulla natura del bene oppure togliere il flag.`);
            }

            // 3. Verifica leasing con deducibilità piena
            if (p.debt_related === true && p.deducibilita_ires_pct === 100 && p.iva_detraibilita_pct === 100) {
              const desc = String(p.description || '').toLowerCase();
              if (/leasing|locazione finanziaria|noleggio/.test(desc)) {
                issues.push(`VERIFICA: è un leasing con deducibilità 100%/100%. Sei CERTO che il bene sia strumentale? Se non lo sai, abbassa la confidence e genera un dubbio.`);
              }
            }

            // 4. Verifica che SRL/SPA non abbiano ritenuta
            if (p.ritenuta_applicabile === true) {
              const cpTipo = counterparty?.tipo_soggetto || counterparty?.legal_type || '';
              if (/s\.?r\.?l|s\.?p\.?a|societa.*capital/i.test(cpTipo)) {
                issues.push(`ERRORE: ritenuta applicata a una ${cpTipo}. Le società di capitali NON sono soggette a ritenuta d'acconto.`);
              }
            }

            // 5. Verifica reverse charge coerente con natura
            const lineData = lines.find((l: any) => l.line_id === p.line_id);
            if (lineData?.vat_nature?.startsWith('N6') && !p.reverse_charge) {
              issues.push(`ATTENZIONE: la riga ha natura ${lineData.vat_nature} (reverse charge) ma reverse_charge=false. Correggi.`);
            }

            const status = issues.length === 0 ? "✅ OK" : `⚠️ ${issues.length} problemi`;
            feedback.push(`Riga [${p.line_id || 'N/D'}] (${p.account_code || 'nessun conto'}): ${status}`);
            if (issues.length > 0) {
              feedback.push(...issues.map((i: string) => `  → ${i}`));
            }
          }

          feedback.push("");
          feedback.push("Rivedi i problemi segnalati sopra. Correggi le tue proposte e poi emetti il JSON finale.");

          return { validation_feedback: feedback.join("\n") };
        }

        case "web_search": {
          return handleWebSearch(args);
        }

        case "stendi_bozza_e_fai_autocritica": {
          const { ipotesi_iniziale, ragioni_a_favore, cosa_potrebbe_essere_sbagliato_o_mancante, decisione_se_coinvolgere_cfo } = args;
          
          let feedback = "Appunti di ragionamento registrati nel buffer interno:\n";
          feedback += `- Ipotesi: ${ipotesi_iniziale}\n`;
          feedback += `- Autocritica (Falle/Assunzioni): ${cosa_potrebbe_essere_sbagliato_o_mancante}\n`;
          feedback += `- CFO: ${decisione_se_coinvolgere_cfo}\n\n`;
          feedback += "ISTRUZIONE DI SISTEMA: Ora RILEGGI attentamente la tua stessa autocritica. Se hai evidenziato che la tua ipotesi si basa su assunzioni non provate (es. deduci la natura del hardware solo dall'ATECO ma non hai il dettaglio in fattura), DEVI essere conservativo: imposta needs_consultant a true, metti i dubbi in 'doubts' e abbassa la confidence. Poi procedi con l'output JSON finale.";
          
          return { message: feedback };
        }

        default:
          return { error: `Tool sconosciuto: ${name}` };
      }
    }

    // ─── Call LLM with tools (any provider) ──────
    const model = agentConfig?.model || "gemini-2.5-pro";
    const temperature = agentConfig?.temperature ?? 0.2;
    const maxOutputTokens = agentConfig?.max_output_tokens || 32768;

    const dynamicTools = [...TOOL_DECLARATIONS];
    if (agentConfig?.react_mode) {
      dynamicTools.push({
        name: "stendi_bozza_e_fai_autocritica",
        description: "Modalità ReAct: Usa questo tool per scrivere la tua ipotesi e fare autocritica prima di decidere. Obbligatorio per righe complesse.",
        parameters: {
          type: "OBJECT",
          properties: {
            ipotesi_iniziale: { type: "STRING", description: "Qual è la tua classificazione preliminare (es. conto, deducibilità)?" },
            ragioni_a_favore: { type: "STRING", description: "Perché pensi che questa ipotesi sia corretta?" },
            cosa_potrebbe_essere_sbagliato_o_mancante: { type: "STRING", description: "AUTOCRITICA (Estremamente importante): C'è qualche assunzione (es. basata su ATECO o descrizione generica)? Manca il nesso con un bene specifico? Potrebbe essere un conto diverso?" },
            decisione_se_coinvolgere_cfo: { type: "STRING", description: "Alla luce dell'autocritica, ritieni necessario che il CFO o l'utente confermino la destinazione d'uso o il tipo di bene?" }
          },
          required: ["ipotesi_iniziale", "ragioni_a_favore", "cosa_potrebbe_essere_sbagliato_o_mancante", "decisione_se_coinvolgere_cfo"],
        },
      });
    }

    const isGeminiModel = (model || "").startsWith("gemini");
    if (agentConfig?.web_search_enabled && isGeminiModel) {
      dynamicTools.push(WEB_SEARCH_TOOL_DECLARATION);
    }

    // ─── Gemini responseSchema: forces structured JSON output ──────
    const responseSchema: Record<string, unknown> | undefined =
      model.startsWith("gemini-") ? {
        type: "OBJECT",
        properties: {
          invoice_summary: { type: "STRING" },
          needs_consultant: { type: "BOOLEAN" },
          consultant_reason: { type: "STRING", nullable: true },
          lines: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                line_id: { type: "STRING" },
                account_code: { type: "STRING", nullable: true },
                account_id: { type: "STRING", nullable: true },
                category_id: { type: "STRING", nullable: true },
                confidence: { type: "INTEGER" },
                reasoning: { type: "STRING" },
                fiscal: {
                  type: "OBJECT",
                  properties: {
                    iva_detraibilita_pct: { type: "INTEGER" },
                    deducibilita_ires_pct: { type: "INTEGER" },
                    irap_mode: { type: "STRING" },
                    ritenuta_applicabile: { type: "BOOLEAN" },
                    reverse_charge: { type: "BOOLEAN" },
                    split_payment: { type: "BOOLEAN" },
                    bene_strumentale: { type: "BOOLEAN" },
                    asset_candidate: { type: "BOOLEAN" },
                    debt_related: { type: "BOOLEAN" },
                    costo_personale: { type: "BOOLEAN" },
                    warning_flags: { type: "ARRAY", items: { type: "STRING" } },
                    fiscal_reasoning_short: { type: "STRING" },
                  },
                  required: ["iva_detraibilita_pct", "deducibilita_ires_pct", "irap_mode",
                             "ritenuta_applicabile", "reverse_charge", "split_payment",
                             "bene_strumentale", "warning_flags", "fiscal_reasoning_short"],
                },
                doubts: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      question: { type: "STRING" },
                      impact: { type: "STRING" },
                    },
                    required: ["question", "impact"],
                  },
                },
              },
              required: ["line_id", "confidence", "reasoning", "fiscal", "doubts"],
            },
          },
        },
        required: ["invoice_summary", "needs_consultant", "lines"],
      } : undefined;

    console.log(`[classify-v2] Starting function calling pipeline: model=${model}, lines=${lines.length}`);

    let llmResp;
    try {
      llmResp = await callLLMWithTools(
        systemPrompt,
        userPrompt,
        dynamicTools,
        toolHandler,
        {
          model,
          temperature,
          maxOutputTokens,
          thinkingEffort: agentConfig?.thinking_effort,
          webSearchEnabled: agentConfig?.web_search_enabled,
          responseSchema,
        },
        { geminiKey, anthropicKey, openaiKey },
        10,
      );
    } catch (e: any) {
      console.error("[classify-v2] LLM call failed:", e.message);
      await sql.end();
      return json({ error: e.message }, 502);
    }

    console.log(`[classify-v2] Completed: ${llmResp.tool_calls_log.length} tool calls made`);

    // ─── DIAG POINT 1: After LLM call, before parsing ──────
    console.log(`[classify-v2-DIAG] LLM response: text.length=${llmResp.text?.length || 0}, structured=${llmResp.structured ? 'YES' : 'NO'}, structured.lines=${llmResp.structured?.lines?.length ?? 'N/A'}, tool_calls=${llmResp.tool_calls_log.length}`);
    if (!llmResp.structured) {
      console.log(`[classify-v2-DIAG] extractJson FAILED. First 500 chars of text: ${(llmResp.text || '').slice(0, 500)}`);
    }

    // ─── Parse & normalize response ──────
    let rawParsed: { invoice_summary: string; needs_consultant: boolean; consultant_reason: string | null; lines: any[] } = {
      invoice_summary: "",
      needs_consultant: false,
      consultant_reason: null,
      lines: [],
    };

    if (llmResp.structured) {
      const s = llmResp.structured;
      rawParsed = {
        invoice_summary: s.invoice_summary || "",
        needs_consultant: Boolean(s.needs_consultant),
        consultant_reason: s.consultant_reason || null,
        lines: Array.isArray(s.lines) ? s.lines : [],
      };
    }

    // ─── DIAG POINT 2: After rawParsed ──────
    console.log(`[classify-v2-DIAG] rawParsed.lines.length=${rawParsed.lines.length}, needs_consultant=${rawParsed.needs_consultant}`);
    if (rawParsed.lines.length > 0) {
      console.log(`[classify-v2-DIAG] First line: line_id=${rawParsed.lines[0].line_id}, account_code=${rawParsed.lines[0].account_code}, account_id=${rawParsed.lines[0].account_id}`);
    }

    // BUG 1 FIX: Normalize any AI output format (flat or wrapped { value, state })
    const normalizedLines = rawParsed.lines.map((raw: any) => normalizeLineProposal(raw));

    // ─── DIAG POINT 3: After normalization ──────
    console.log(`[classify-v2-DIAG] normalizedLines.length=${normalizedLines.length}`);
    for (const nl of normalizedLines) {
      console.log(`[classify-v2-DIAG] Normalized: line_id=${nl.line_id}, account_code=${nl.account_code}, account_id=${nl.account_id}, confidence=${nl.confidence}`);
    }

    // BUG 2 FIX: Resolve account_code → account_id via chart_of_accounts
    const allAccounts = await sql`
      SELECT id, code, name, section FROM chart_of_accounts
      WHERE company_id = ${companyId} AND active = true AND is_header = false`;
    const accountByCode = new Map(allAccounts.map((a: any) => [a.code, a]));

    for (const line of normalizedLines) {
      // Validate irap_mode against DB check constraint
      if (line.fiscal) {
        const validModes = ['follows_ires', 'fully_indeducible', 'custom_pct', 'personale'];
        if (!validModes.includes(line.fiscal.irap_mode)) {
          console.warn(`[classify-v2] Invalid irap_mode "${line.fiscal.irap_mode}" for line ${line.line_id}, falling back to "follows_ires"`);
          line.fiscal.irap_mode = 'follows_ires';
        }
      }

      // Resolve account_code → account_id
      if (line.account_code && !line.account_id) {
        const match = accountByCode.get(line.account_code);
        if (match) {
          line.account_id = match.id;
        } else {
          // Try partial match (code with/without dots)
          const cleanCode = line.account_code.replace(/\./g, "");
          for (const [codeStr, acc] of Array.from(accountByCode.entries())) {
            const accObj = acc as any;
            if (String(codeStr).replace(/\./g, "") === cleanCode) {
              line.account_id = accObj.id;
              line.account_code = String(codeStr);
              break;
            }
          }
          if (!line.account_id) {
            console.warn(`[classify-v2] Account code "${line.account_code}" not found in chart`);
          }
        }
      }

      // Resolve category_id if it's a name (not UUID)
      if (line.category_id && !isUUID(line.category_id)) {
        const [catMatch] = await sql`
          SELECT id FROM categories
          WHERE company_id = ${companyId} AND active = true
            AND lower(name) = ${line.category_id.toLowerCase()}
          LIMIT 1`;
        if (catMatch) {
          line.category_id = catMatch.id;
        } else {
          line.category_id = null;
        }
      }
    }

    // ─── DIAG POINT 4: After code→UUID resolution ──────
    console.log(`[classify-v2-DIAG] After resolution: ${normalizedLines.map(l => `${l.line_id?.slice(0,8)}→acc=${l.account_id?.slice(0,8)||'NULL'}`).join(', ')}`);

    // BUG 4 FIX: Auto-detect needs_consultant
    let autoNeedsConsultant = rawParsed.needs_consultant;
    let autoConsultantReason = rawParsed.consultant_reason;

    const unresolvedLines = normalizedLines.filter((l) => !l.account_id && !l.account_code);
    if (unresolvedLines.length > 0 && !autoNeedsConsultant) {
      autoNeedsConsultant = true;
      autoConsultantReason = `${unresolvedLines.length} righe senza conto assegnato: ${unresolvedLines.map((l) => `"${l.reasoning?.slice(0, 50)}"`).join(", ")}`;
      console.log(`[classify-v2] Auto-escalated to consultant: ${autoConsultantReason}`);
    }

    const linesWithDoubts = normalizedLines.filter((l) => l.doubts.length > 0);
    if (linesWithDoubts.length > 0 && !autoNeedsConsultant) {
      autoNeedsConsultant = true;
      autoConsultantReason = `Dubbi su ${linesWithDoubts.length} righe: ${linesWithDoubts.flatMap((l) => l.doubts.map((d) => d.question)).join("; ")}`;
    }

    // ─── Build backward-compatible response ──────
    const classifications = normalizedLines.map((lp) => ({
      line_id: lp.line_id,
      article_code: null,
      phase_code: null,
      category_id: lp.category_id,
      category_name: null,
      account_id: lp.account_id,
      account_code: lp.account_code,
      confidence: lp.confidence || 0,
      reasoning: lp.reasoning || "",
      rationale_summary: lp.rationale_summary || lp.reasoning || null,
      decision_basis: lp.decision_basis.length > 0 ? lp.decision_basis : ["function_calling"],
      supporting_factors: lp.supporting_factors,
      supporting_evidence: [],
      weak_fields: {
        category: { value: lp.category_id, state: lp.category_id ? "assigned" : "needs_review" },
        account: { value: lp.account_id, state: lp.account_id ? "assigned" : "needs_review" },
        article: { value: null, state: "unassigned" },
        phase: { value: null, state: "unassigned" },
        cost_center: { value: null, state: "unassigned" },
      },
      exact_match_evidence_used: false,
      fiscal_flags: {
        ritenuta_acconto: lp.fiscal.ritenuta_applicabile
          ? { aliquota: lp.fiscal.ritenuta_aliquota_pct || 20, base: `${lp.fiscal.ritenuta_base_pct || 100}%` }
          : null,
        reverse_charge: lp.fiscal.reverse_charge || false,
        split_payment: lp.fiscal.split_payment || false,
        bene_strumentale: lp.fiscal.bene_strumentale || false,
        deducibilita_pct: lp.fiscal.deducibilita_ires_pct ?? 100,
        iva_detraibilita_pct: lp.fiscal.iva_detraibilita_pct ?? 100,
        note: lp.fiscal.fiscal_reasoning_short || null,
      },
      // New v1 fiscal fields (passed through to pipeline)
      fiscal_v1: lp.fiscal,
      doubts: lp.doubts,
      suggest_new_account: null,
      suggest_new_category: null,
    }));

    // ─── DIAG POINT 5: Final response ──────
    console.log(`[classify-v2-DIAG] classifications.length=${classifications.length}, withAccount=${classifications.filter((c: any) => c.account_id).length}, withCategory=${classifications.filter((c: any) => c.category_id).length}`);

    await sql.end();

    return json({
      classifications,
      commercialista: {
        invoice_summary: rawParsed.invoice_summary,
        evidence_refs: [],
        needs_consultant_hint: autoNeedsConsultant,
        needs_consultant: autoNeedsConsultant,
        consultant_reason: autoConsultantReason,
        line_proposals: classifications,
      },
      thinking: llmResp.thinking || null,
      prompt_length: userPrompt.length,
      model_used: model,
      tool_calls: llmResp.tool_calls_log,
      tool_calls_count: llmResp.tool_calls_log.length,
      _debug: {
        raw_response: llmResp.text || null,
        model_used: model,
        agent_config_loaded: !!agentConfig,
        tool_calls: llmResp.tool_calls_log,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[classify-v2] Error:", msg);
    return json({ error: msg }, 500);
  }
});
