// classify-v2-classify — Stage B: Classification with Function Calling
// Commercialista AI classifies ALL invoice lines in ONE call.
// Uses 7 tools on-demand instead of preloading all context into the prompt.
// Supports any model (Gemini, OpenAI, Claude) configured in agent_config.
//
// Tools: cerca_conti, get_defaults_conto, storico_controparte,
//        get_tax_codes, get_parametro_fiscale, get_profilo_controparte, consulta_kb

import postgres from "npm:postgres@3.4.5";
import { callLLMWithTools, type ToolDeclaration } from "../_shared/llm-caller.ts";
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
  tax_code: string | null;
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
  max_output_tokens: number;
}

/* ─── Tool Declarations ──────────────────── */

const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "cerca_conti",
    description: "Cerca nel piano dei conti dell'azienda per parole chiave e/o sezione. Restituisce codice, nome, sezione e defaults fiscali dei conti trovati.",
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "Parole chiave per cercare nel nome/codice del conto (es. 'carburante', 'leasing', 'telefono')" },
        section: { type: "STRING", description: "Filtra per sezione: assets, liabilities, equity, revenue, cost_production, cost_personnel, depreciation, other_costs, financial, extraordinary" },
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
];

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
                 date, doc_type, direction, notes, raw_xml
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
        SELECT system_prompt, model, temperature, thinking_budget, max_output_tokens
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
    const systemPrompt = agentConfig?.system_prompt || `Sei un commercialista italiano senior specializzato in PMI.

COMPITO: Classifica ogni riga della fattura. Per ciascuna:
1. Cerca il conto giusto nel piano dei conti (tool: cerca_conti)
2. Verifica lo storico della controparte (tool: storico_controparte)
3. Determina IVA, deducibilità IRES, IRAP, ritenute, competenza, cespiti
4. Se la riga è fiscalmente complessa (leasing, auto, RC), consulta la KB
5. Se hai dubbi, segnalali — MAI tirare a indovinare

REGOLE:
- L'aliquota IVA in fattura è un DATO DI FATTO — non contraddirla
- Percentuali: SEMPRE numeri 0-100
- Quando non sai: default CONSERVATIVO + dubbio
- Se il conto ha needs_user_confirmation=true: SEMPRE dubbio
- Fattura ATTIVA (vendita) → MAI passività
- SRL/SPA → MAI ritenuta d'acconto`;

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
${invoiceNotes ? `Note: ${invoiceNotes}` : ""}${invoiceCausale ? ` | Causale XML: ${invoiceCausale}` : ""}

CONTROPARTE:
${cpInfo}

AZIENDA:
${company.name} (P.IVA: ${company.vat_number || "N/D"})
ATECO: ${company.ateco_code || "N/D"} ${company.ateco_description || ""} | Regime: ${company.fiscal_regime || "ordinario"} | IVA per cassa: ${company.iva_per_cassa ? "SI" : "NO"}

RIGHE:
${linesText}

ISTRUZIONI:
USA I TOOL per cercare conti, storico, KB. Ragiona. Poi rispondi JSON.

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
      "tax_code": "22",
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
          let rows;
          if (section) {
            rows = await sql`
              SELECT id, code, name, section, default_tax_code_id, default_ires_pct,
                     default_irap_mode, needs_user_confirmation, note_fiscali
              FROM chart_of_accounts
              WHERE company_id = ${companyId} AND active = true AND is_header = false
                AND section = ${section}
                AND (name ILIKE ${'%' + query + '%'} OR code ILIKE ${'%' + query + '%'})
              ORDER BY code LIMIT 15`;
          } else {
            rows = await sql`
              SELECT id, code, name, section, default_tax_code_id, default_ires_pct,
                     default_irap_mode, needs_user_confirmation, note_fiscali
              FROM chart_of_accounts
              WHERE company_id = ${companyId} AND active = true AND is_header = false
                AND (name ILIKE ${'%' + query + '%'} OR code ILIKE ${'%' + query + '%'})
              ORDER BY code LIMIT 15`;
          }
          return rows;
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
          return rows.length > 0 ? rows : { message: "Nessuno storico confermato per questa controparte" };
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
                section_title: c.section_title,
                article_reference: c.article_reference,
                content: c.content.slice(0, 500),
              })),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[classify-v2] consulta_kb failed:", msg);
            return { error: `KB search failed: ${msg}` };
          }
        }

        default:
          return { error: `Tool sconosciuto: ${name}` };
      }
    }

    // ─── Call LLM with tools (any provider) ──────
    const model = agentConfig?.model || "gemini-2.5-pro";
    const temperature = agentConfig?.temperature ?? 0.2;
    const maxOutputTokens = agentConfig?.max_output_tokens || 32768;

    console.log(`[classify-v2] Starting function calling pipeline: model=${model}, lines=${lines.length}`);

    let llmResp;
    try {
      llmResp = await callLLMWithTools(
        systemPrompt,
        userPrompt,
        TOOL_DECLARATIONS,
        toolHandler,
        { model, temperature, maxOutputTokens },
        { geminiKey, anthropicKey, openaiKey },
        10,
      );
    } catch (e: any) {
      console.error("[classify-v2] LLM call failed:", e.message);
      await sql.end();
      return json({ error: e.message }, 502);
    }

    console.log(`[classify-v2] Completed: ${llmResp.tool_calls_log.length} tool calls made`);

    // ─── Parse response ──────
    let parsed: CommercialistaResponse = {
      invoice_summary: "",
      needs_consultant: false,
      consultant_reason: null,
      lines: [],
    };

    if (llmResp.structured) {
      const s = llmResp.structured;
      parsed = {
        invoice_summary: s.invoice_summary || "",
        needs_consultant: Boolean(s.needs_consultant),
        consultant_reason: s.consultant_reason || null,
        lines: Array.isArray(s.lines) ? s.lines : [],
      };
    }

    // ─── Build backward-compatible response ──────
    // Map line proposals to the format expected by classificationPipelineService
    const classifications = parsed.lines.map((lp) => ({
      line_id: lp.line_id,
      article_code: null,
      phase_code: null,
      category_id: lp.category_id,
      category_name: null,
      account_id: lp.account_id,
      account_code: lp.account_code,
      confidence: lp.confidence || 0,
      reasoning: lp.reasoning || "",
      rationale_summary: lp.reasoning || null,
      decision_basis: ["function_calling"],
      supporting_factors: [],
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
        ritenuta_acconto: lp.fiscal?.ritenuta_applicabile
          ? { aliquota: lp.fiscal.ritenuta_aliquota_pct || 20, base: `${lp.fiscal.ritenuta_base_pct || 100}%` }
          : null,
        reverse_charge: lp.fiscal?.reverse_charge || false,
        split_payment: lp.fiscal?.split_payment || false,
        bene_strumentale: lp.fiscal?.bene_strumentale || false,
        deducibilita_pct: lp.fiscal?.deducibilita_ires_pct ?? 100,
        iva_detraibilita_pct: lp.fiscal?.iva_detraibilita_pct ?? 100,
        note: lp.fiscal?.fiscal_reasoning_short || null,
      },
      // New v1 fiscal fields (passed through to pipeline)
      fiscal_v1: lp.fiscal || null,
      doubts: lp.doubts || [],
      suggest_new_account: null,
      suggest_new_category: null,
    }));

    await sql.end();

    return json({
      classifications,
      commercialista: {
        invoice_summary: parsed.invoice_summary,
        evidence_refs: [],
        needs_consultant_hint: parsed.needs_consultant,
        needs_consultant: parsed.needs_consultant,
        consultant_reason: parsed.consultant_reason,
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
