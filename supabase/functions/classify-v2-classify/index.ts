// classify-v2-classify — Stage B: Classification
// Takes understanding results from Stage A and assigns account, category, article.
// Loads ALL active accounts (Stage A sections are prompt GUIDANCE, not a hard filter).
// Produces: category_id, account_id, article_code, phase_code, confidence, fiscal_flags.
//
// v3: Reads agent_config, agent_rules, knowledge_base from Admin Panel DB.

import postgres from "npm:postgres@3.4.5";
import {
  getCompanyMemoryBlock,
  getUserInstructionsBlock,
  type CompanyContext,
  type MemoryFact,
} from "../_shared/accounting-system-prompt.ts";
import {
  filterCompanyMemoryForInvoiceClassification,
  getInvoiceContractRefs,
  type CompanyMemoryQueryRow,
} from "../_shared/company-memory-filter.ts";
import {
  formatKbAdvisoryNotesContext,
  formatKbSourceChunksContext,
  inferKbCounterpartyTags,
  inferKbOperationTags,
  loadKbAdvisoryContext,
  shouldConsultKbAdvisory,
} from "../_shared/kb-advisory.ts";
import { callLLM } from "../_shared/llm-caller.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

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

interface Understanding {
  line_id: string;
  operation_type: string;
  account_sections: string[];
  is_NOT: string[];
  reasoning: string;
}

interface FiscalFlags {
  ritenuta_acconto: { aliquota: number; base: string } | null;
  reverse_charge: boolean;
  split_payment: boolean;
  bene_strumentale: boolean;
  deducibilita_pct: number;
  iva_detraibilita_pct: number;
  note: string | null;
}

interface WeakField<T = string | null> {
  value: T | null;
  state: "assigned" | "unassigned" | "needs_review";
}

interface SupportingEvidence {
  source: string;
  label: string;
  detail?: string | null;
  ref?: string | null;
}

interface ClassifyResult {
  line_id: string;
  article_code: string | null;
  phase_code: string | null;
  category_id: string | null;
  category_name: string | null;
  account_id: string | null;
  account_code: string | null;
  confidence: number;
  reasoning: string;
  fiscal_flags: FiscalFlags;
  rationale_summary?: string | null;
  decision_basis?: string[];
  supporting_factors?: string[];
  supporting_evidence?: SupportingEvidence[];
  weak_fields?: {
    category?: WeakField;
    account?: WeakField;
    article?: WeakField;
    phase?: WeakField;
    cost_center?: WeakField;
  };
  exact_match_evidence_used?: boolean;
  suggest_new_account?: {
    code: string; name: string; section: string; parent_code: string; reason: string;
  } | null;
  suggest_new_category?: {
    name: string; type: string; reason: string;
  } | null;
}

interface CommercialistaResponse {
  invoice_summary?: string | null;
  evidence_refs?: string[];
  needs_consultant_hint?: boolean;
  line_proposals: ClassifyResult[];
}

/* ─── Admin Panel types ─────────────────── */

interface AgentConfig {
  agent_type: string;
  system_prompt: string;
  model: string;
  model_escalation?: string | null;
  temperature: number;
  thinking_level: string;
  thinking_budget?: number | null;
  max_output_tokens: number;
}

interface AgentRule {
  title: string;
  rule_text: string;
  trigger_keywords: string[];
  sort_order: number;
}

/* ─── Format helpers ─────────────────────── */

function formatAgentRules(rules: AgentRule[]): string {
  if (rules.length === 0) return "";
  const lines = ["=== REGOLE OPERATIVE ==="];
  rules.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.title}] — ${r.rule_text}`);
  });
  return lines.join("\n");
}

/* ─── Direction enforcement ──────────────── */

const SECTIONS_FOR_DIRECTION: Record<string, { primary: string[]; allowed: string[] }> = {
  in: {
    primary: ["cost_production", "cost_personnel", "depreciation", "other_costs"],
    allowed: ["cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "assets", "liabilities"],
  },
  out: {
    primary: ["revenue"],
    allowed: ["revenue", "financial", "extraordinary", "assets", "liabilities"],
  },
};

const CAT_TYPES_FOR_DIRECTION: Record<string, string[]> = {
  in: ["expense", "both"],
  out: ["revenue", "both"],
};

/* ─── Embedding helper ───────────────────── */

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}]`;
}

async function callGeminiEmbedding(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EXPECTED_DIMS,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini embedding error: ${payload?.error?.message || response.status}`);
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) throw new Error("Bad embedding dims");
  return values.map((v: unknown) => Number(v));
}

// Extracted to json-helpers.ts

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const openaiKey = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: {
    company_id?: string;
    invoice_id?: string;
    lines?: InputLine[];
    understandings?: Understanding[];
    deterministic_matches?: ExactMatchEvidence[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const understandings = body.understandings || [];
  const deterministicMatches = body.deterministic_matches || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const invoiceNotes = body.invoice_notes || null;
  const invoiceCausale = body.invoice_causale || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // Build understanding map
    const underMap = new Map(understandings.map((u) => [u.line_id, u]));
    const exactMatchMap = new Map(deterministicMatches.map((match) => [match.line_id, match]));

    const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
    const lineDescriptions = lines.map((l) => l.description || "");

    // ─── Load context + Admin Panel infrastructure in parallel ──────
    const [articles, categories, accounts, phases, companyRow, invoiceRow, agentConfigs, agentRules] = await Promise.all([
      sql`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true AND type = ANY(${allowedCatTypes}::text[]) ORDER BY sort_order, name`,
      sql`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false ORDER BY code`,
      sql`SELECT id, article_id, code, name, phase_type, is_counting_point, invoice_direction FROM article_phases WHERE company_id = ${companyId} AND active = true ORDER BY article_id, sort_order`,
      sql`SELECT name, vat_number, ateco_code FROM companies WHERE id = ${companyId} LIMIT 1`,
      sql`SELECT primary_contract_ref, contract_refs FROM invoices WHERE id = ${invoiceId} LIMIT 1`,
      // Agent config for commercialista
      sql<AgentConfig[]>`
        SELECT agent_type, system_prompt, model, model_escalation, temperature, thinking_level, thinking_budget, max_output_tokens
        FROM agent_config WHERE active = true AND agent_type = 'commercialista'
        LIMIT 1`,
      // Agent rules for commercialista
      sql<AgentRule[]>`
        SELECT title, rule_text, trigger_keywords, sort_order
        FROM agent_rules WHERE active = true AND agent_type = 'commercialista'
        ORDER BY sort_order`,
    ]);

    const companyName = companyRow[0]?.name || "";
    const companyVat = companyRow[0]?.vat_number || "";
    const companyAteco = companyRow[0]?.ateco_code || "";
    const agentConfig = agentConfigs[0] || null;
    const invoiceContractRefs = getInvoiceContractRefs(
      invoiceRow[0]?.primary_contract_ref || null,
      invoiceRow[0]?.contract_refs || null,
    );

    console.log(`[classify-v2] Loaded: ${accounts.length} accounts (ALL sections), ${categories.length} cats, ${articles.length} articles`);
    console.log(`[classify-v2] Admin Panel: config=${agentConfig ? "✓" : "✗"} rules=${agentRules.length}`);

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyAtecoFull = "";
    let counterpartyLegalType = "";
    let counterpartyBusinessSector = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cpRow] = await sql`
          SELECT ateco_code, ateco_description, business_sector, legal_type, address
          FROM counterparties WHERE company_id = ${companyId} AND vat_key = ${vatKey} LIMIT 1`;
        if (cpRow) {
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (cpRow.ateco_code) { parts.push(`ATECO: ${cpRow.ateco_code} ${cpRow.ateco_description || ""}`); counterpartyAtecoFull = cpRow.ateco_code; }
          if (cpRow.business_sector) {
            parts.push(`Settore: ${cpRow.business_sector}`);
            counterpartyBusinessSector = cpRow.business_sector;
          }
          if (cpRow.legal_type) { parts.push(`Tipo: ${cpRow.legal_type}`); counterpartyLegalType = cpRow.legal_type; }
          if (cpRow.address) parts.push(`Sede: ${cpRow.address}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // Company context
    const companyContext: CompanyContext | undefined = companyRow.length > 0
      ? { company_name: companyName, sector: "servizi", vat_number: companyVat, ateco_code: companyAteco }
      : undefined;

    // User instructions
    const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);

    // Memory via embedding
    let memoryBlock = "";
    let queryVecLiteral = "";
    try {
      const queryText = lines.map((l) => l.description).join(" | ") + ` | ${counterpartyName}`;
      const queryVec = await callGeminiEmbedding(geminiKey, queryText);
      queryVecLiteral = toVectorLiteral(queryVec);
      const memRows = await sql.unsafe(
        `SELECT
            cm.fact_text,
            cm.fact_type,
            cm.source,
            cm.metadata,
            src.primary_contract_ref AS source_primary_contract_ref,
            src.contract_refs AS source_contract_refs,
            src.classification_status AS source_classification_status,
            (1 - (cm.embedding <=> $1::halfvec(3072)))::float as similarity
         FROM company_memory cm
         LEFT JOIN invoices src
           ON src.id = CASE
             WHEN cm.metadata ? 'source_invoice_id'
              AND (cm.metadata->>'source_invoice_id') ~* '^[0-9a-f-]{36}$'
             THEN (cm.metadata->>'source_invoice_id')::uuid
             ELSE NULL
           END
         WHERE cm.company_id = $2 AND cm.active = true AND cm.embedding IS NOT NULL
         ORDER BY cm.embedding <=> $1::halfvec(3072) LIMIT 15`,
        [queryVecLiteral, companyId],
      );
      const memFacts = filterCompanyMemoryForInvoiceClassification(
        (memRows as CompanyMemoryQueryRow[]).filter((row) => (row.similarity || 0) >= 0.40),
        lines.map((line) => line.description || ""),
        invoiceContractRefs,
      );
      memoryBlock = getCompanyMemoryBlock(memFacts);
    } catch (e) {
      console.warn("[classify-v2] Memory embedding failed:", e);
    }

    let kbNotesSection = "";
    let kbChunksSection = "";
    let kbNoteTitles: string[] = [];
    let kbChunkDebug: { title: string; similarity: number }[] = [];
    if (queryVecLiteral && shouldConsultKbAdvisory({
      mode: "commercialista",
      lineDescriptions,
      exactMatchCount: deterministicMatches.length,
      totalLines: lines.length,
    })) {
      try {
        const advisoryContext = await loadKbAdvisoryContext(sql, {
          companyId,
          audience: "commercialista",
          queryVecLiteral,
          companyAteco,
          counterpartyName,
          counterpartyTags: inferKbCounterpartyTags(
            counterpartyName,
            counterpartyLegalType,
            counterpartyBusinessSector,
          ),
          operationTags: inferKbOperationTags(lineDescriptions),
          invoiceAmount: lines.reduce((sum, line) => sum + Number(line.total_price || 0), 0),
          noteLimit: 2,
          chunkLimit: 2,
        });
        if (advisoryContext.notes.length > 0) {
          kbNotesSection = `=== NOTE CONSULTIVE KB ===\n${formatKbAdvisoryNotesContext(advisoryContext.notes)}`;
          kbNoteTitles = advisoryContext.notes.map((note) => note.title);
        }
        if (advisoryContext.chunks.length > 0) {
          kbChunksSection = `=== FONTI KB CITABILI ===\n${formatKbSourceChunksContext(advisoryContext.chunks)}`;
          kbChunkDebug = advisoryContext.chunks.map((chunk) => ({
            title: chunk.section_title || chunk.doc_title || "Documento",
            similarity: chunk.similarity,
          }));
        }
        console.log(`[classify-v2] KB advisory notes=${advisoryContext.notes.length} chunks=${advisoryContext.chunks.length}`);
      } catch (e) {
        console.warn("[classify-v2] KB advisory retrieval failed:", e);
      }
    }

    // Cross-counterparty article history
    let articleHistorySection = "";
    try {
      const artHist = await sql`
        SELECT il.description, art.code as article_code, art.name as article_name,
               ap.code as phase_code, ap.name as phase_name, count(*)::int as count
        FROM invoice_line_articles ila
        JOIN articles art ON ila.article_id = art.id
        LEFT JOIN article_phases ap ON ila.phase_id = ap.id
        JOIN invoice_lines il ON ila.invoice_line_id = il.id
        JOIN invoices i ON ila.invoice_id = i.id
        WHERE ila.company_id = ${companyId} AND ila.verified = true AND i.direction = ${direction}
        GROUP BY il.description, art.code, art.name, ap.code, ap.name
        HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 20`;
      if (artHist.length > 0) {
        articleHistorySection = `\nSTORICO ARTICOLI (pattern confermati):\n` +
          artHist.map((ah: any) => `- "${ah.description}" → art:${ah.article_code}${ah.phase_code ? ` fase:${ah.phase_code}` : ""} [${ah.count}x]`).join("\n");
      }
    } catch { /* ignore */ }

    // Counterparty history (top 15)
    let historySection = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const hist = await sql`
          SELECT il.description, c.name as category_name, a.code as account_code, a.name as account_name
          FROM invoice_lines il
          JOIN invoices i ON il.invoice_id = i.id
          LEFT JOIN categories c ON il.category_id = c.id
          LEFT JOIN chart_of_accounts a ON il.account_id = a.id
          WHERE i.company_id = ${companyId} AND i.direction = ${direction}
            AND i.counterparty_id = (SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${companyId} LIMIT 1)
            AND i.classification_status = 'confirmed'
            AND il.category_id IS NOT NULL
          ORDER BY i.date DESC LIMIT 15`;
        if (hist.length > 0) {
          historySection = `STORICO CONTROPARTE:\n` +
            hist.map((h: any) => `"${h.description}" → cat:${h.category_name}, conto:${h.account_code} ${h.account_name}`).join("\n");
        }
      }
    }

    // Build phases-by-article
    const phasesByArticle = new Map<string, typeof phases>();
    for (const p of phases as any[]) {
      if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
      phasesByArticle.get(p.article_id)!.push(p);
    }

    // Build compact sections for prompt
    const catSection = (categories as any[]).map((c) => `- ${c.id}: ${c.name} (${c.type})`).join("\n");
    const accSection = (accounts as any[]).map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n");

    let artSection = "";
    for (const a of articles as any[]) {
      const ps = phasesByArticle.get(a.id);
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      if (ps && ps.length > 0) {
        artSection += `- ${a.code} (${a.name})${kwPart}:\n${ps.map((p: any) => `  ${p.code}: ${p.name}`).join("\n")}\n`;
      } else {
        artSection += `- ${a.code} (${a.name})${kwPart}\n`;
      }
    }

    // Lines with understanding context
    const lineEntries = lines.map((l, i) => {
      const u = underMap.get(l.line_id);
      const exactMatch = exactMatchMap.get(l.line_id);
      const uCtx = u ? ` → COMPRENSIONE: "${u.operation_type}" sections=${u.account_sections.join(",")}${u.is_NOT.length ? ` NOT=[${u.is_NOT.join("; ")}]` : ""}` : "";
      const exactCtx = exactMatch
        ? ` → EXACT_MATCH_EVIDENCE: source=${exactMatch.source} conf=${exactMatch.confidence} note="${exactMatch.reasoning}"`
        : "";
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}${uCtx}${exactCtx}`;
    }).join("\n");

    // ─── Build prompt with Admin Panel data ──────────────────
    const promptParts: string[] = [];

    // 1. System prompt from agent_config (or fallback)
    if (agentConfig?.system_prompt) {
      promptParts.push(agentConfig.system_prompt);
    } else {
      promptParts.push("Sei un COMMERCIALISTA SENIOR italiano. Classifica ogni riga della fattura.");
    }
    promptParts.push("");

    // 2. Agent rules (CRITICAL: BEFORE lines and context)
    const rulesBlock = formatAgentRules(agentRules);
    if (rulesBlock) {
      promptParts.push(rulesBlock);
      promptParts.push("");
    }

    // 3. KB consultiva mirata
    if (kbNotesSection) {
      promptParts.push(kbNotesSection);
      promptParts.push("");
    }
    if (kbChunksSection) {
      promptParts.push(kbChunksSection);
      promptParts.push("");
    }

    // 4. Company + counterparty context
    promptParts.push("=== CONTESTO AZIENDA ===");
    promptParts.push(`AZIENDA: ${companyName} (P.IVA: ${companyVat})`);
    if (companyAteco) promptParts.push(`ATECO: ${companyAteco}`);
    promptParts.push(`CONTROPARTE: ${counterpartyInfo}`);
    promptParts.push(`DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}`);
    promptParts.push("");

    // 4b. Invoice notes + causale context
    if (invoiceNotes || invoiceCausale) {
      promptParts.push("=== INFORMAZIONI AGGIUNTIVE FATTURA ===");
      if (invoiceCausale) promptParts.push(`Causale fattura (dall'XML): ${invoiceCausale}`);
      if (invoiceNotes) promptParts.push(`Note utente: ${invoiceNotes}`);
      promptParts.push("Usa queste informazioni per capire meglio la natura dell'operazione.");
      promptParts.push("===");
      promptParts.push("");
    }

    // 5. User instructions + memory
    if (userInstructionsBlock) promptParts.push(userInstructionsBlock);
    if (memoryBlock) promptParts.push(memoryBlock);
    promptParts.push("");

    // 6. Evidence policy
    promptParts.push(`IMPORTANTE — POLITICA DELLE EVIDENZE:
Le evidenze di exact match, la memoria aziendale e le note/fonti KB sono supporti al giudizio, non verdetti automatici.
Se un exact match e il contesto attuale coincidono davvero, puoi seguirlo.
Se le evidenze sono parziali, rumorose o non equivalenti, abbassa la confidence e lascia i campi deboli come needs_review o unassigned.
Le comprensioni eventualmente presenti sono una guida, non un vincolo assoluto.`);
    promptParts.push("");

    // 7. Charts of accounts, categories, articles
    promptParts.push(`CATEGORIE:\n${catSection}`);
    promptParts.push("");
    promptParts.push(`CONTI (tutti i conti attivi dell'azienda):\n${accSection}`);
    promptParts.push("");
    if (artSection) { promptParts.push(`ARTICOLI:\n${artSection}`); promptParts.push(""); }
    if (historySection) { promptParts.push(historySection); promptParts.push(""); }
    if (articleHistorySection) { promptParts.push(articleHistorySection); promptParts.push(""); }

    // 8. Lines
    promptParts.push(`RIGHE:\n${lineEntries}`);
    promptParts.push("");

    // 9. Output format
    promptParts.push(`REGOLE DI CLASSIFICAZIONE:
- category_id e account_id: SEMPRE UUID dalla lista sopra
- article_code + phase_code: solo se il materiale corrisponde
- confidence 0-100 (dubbio → bassa, mai confidence alta su scelte incerte)
- fiscal_flags per OGNI riga: ritenuta_acconto (solo professionisti), reverse_charge, split_payment, bene_strumentale (solo beni FISICI > 516€), deducibilita_pct, iva_detraibilita_pct, note
- Righe con tot=0: informative, confidence 30-50
- Se l'evidenza non basta, puoi lasciare category_id/account_id null e marcare i campi deboli come needs_review o unassigned

Rispondi con un JSON object (no markdown):
{
  "invoice_summary":"breve sintesi dell'impostazione della fattura",
  "evidence_refs":["kb:Titolo","memory:Pattern aziendale"],
  "needs_consultant_hint":false,
  "line_proposals":[
    {
      "line_id":"uuid",
      "article_code":"CODE"|null,
      "phase_code":"code"|null,
      "category_id":"uuid"|null,
      "category_name":"nome"|null,
      "account_id":"uuid"|null,
      "account_code":"codice"|null,
      "confidence":0-100,
      "reasoning":"max 30 parole",
      "rationale_summary":"sintesi professionale della scelta o del non deciso",
      "decision_basis":["fattura intera","kb","memoria aziendale"],
      "supporting_factors":["fattore 1","fattore 2"],
      "supporting_evidence":[{"source":"kb","label":"Titolo KB","detail":"breve dettaglio"}],
      "weak_fields":{
        "category":{"value":"uuid"|null,"state":"assigned"|"unassigned"|"needs_review"},
        "account":{"value":"uuid"|null,"state":"assigned"|"unassigned"|"needs_review"},
        "article":{"value":"CODE"|null,"state":"assigned"|"unassigned"|"needs_review"},
        "phase":{"value":"code"|null,"state":"assigned"|"unassigned"|"needs_review"},
        "cost_center":{"value":null,"state":"unassigned"}
      },
      "exact_match_evidence_used":false,
      "fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},
      "suggest_new_account":null,
      "suggest_new_category":null
    }
  ]
}`);

    const prompt = promptParts.join("\n");

    // ─── Call unified LLM ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.2;
    const thinkingLevel = agentConfig?.thinking_level || "medium";
    const thinkingBudgets: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = agentConfig?.thinking_budget ?? thinkingBudgets[thinkingLevel] ?? 8192;

    let llmResp;
    try {
      llmResp = await callLLM(prompt, {
        model,
        temperature,
        thinkingBudget: budget,
        maxOutputTokens: agentConfig?.max_output_tokens || 32768,
        systemPrompt: agentConfig?.system_prompt || "Sei un COMMERCIALISTA SENIOR italiano. Classifica ogni riga della fattura."
      }, { geminiKey, anthropicKey, openaiKey });
    } catch (e: any) {
      await sql.end();
      return json({ error: e.message }, 502);
    }

    let structuredResponse: CommercialistaResponse = { line_proposals: [] };
    if (llmResp.structured) {
      if (Array.isArray(llmResp.structured)) {
        structuredResponse = { line_proposals: llmResp.structured as ClassifyResult[] };
      } else if (typeof llmResp.structured === "object") {
        structuredResponse = {
          invoice_summary: typeof llmResp.structured.invoice_summary === "string" ? llmResp.structured.invoice_summary : null,
          evidence_refs: Array.isArray(llmResp.structured.evidence_refs) ? llmResp.structured.evidence_refs as string[] : [],
          needs_consultant_hint: Boolean(llmResp.structured.needs_consultant_hint),
          line_proposals: Array.isArray(llmResp.structured.line_proposals) ? llmResp.structured.line_proposals as ClassifyResult[] : [],
        };
      }
    }

    let results: ClassifyResult[] = structuredResponse.line_proposals || [];

    // Validate UUIDs — ensure account_id and category_id exist in our loaded data
    const validAccIds = new Set((accounts as any[]).map((a) => a.id));
    const validCatIds = new Set((categories as any[]).map((c) => c.id));

    for (const r of results) {
      if (r.account_id && !validAccIds.has(r.account_id)) {
        if (r.account_code) {
          const match = (accounts as any[]).find((a) => a.code === r.account_code);
          if (match) r.account_id = match.id;
          else r.account_id = null;
        } else {
          r.account_id = null;
        }
      }
      if (r.category_id && !validCatIds.has(r.category_id)) {
        if (r.category_name) {
          const match = (categories as any[]).find((c) => c.name.toLowerCase() === r.category_name!.toLowerCase());
          if (match) r.category_id = match.id;
          else r.category_id = null;
        } else {
          r.category_id = null;
        }
      }
      if (!r.rationale_summary) r.rationale_summary = r.reasoning || null;
      if (!Array.isArray(r.decision_basis)) r.decision_basis = [];
      if (!Array.isArray(r.supporting_factors)) r.supporting_factors = [];
      if (!Array.isArray(r.supporting_evidence)) r.supporting_evidence = [];
      r.weak_fields = {
        category: r.weak_fields?.category || { value: r.category_id || null, state: r.category_id ? "assigned" : "needs_review" },
        account: r.weak_fields?.account || { value: r.account_id || null, state: r.account_id ? "assigned" : "needs_review" },
        article: r.weak_fields?.article || { value: r.article_code || null, state: r.article_code ? "assigned" : "unassigned" },
        phase: r.weak_fields?.phase || { value: r.phase_code || null, state: r.phase_code ? "assigned" : "unassigned" },
        cost_center: r.weak_fields?.cost_center || { value: null, state: "unassigned" },
      };
    }

    await sql.end();

    return json({
      classifications: results,
      commercialista: {
        invoice_summary: structuredResponse.invoice_summary || null,
        evidence_refs: structuredResponse.evidence_refs || [],
        needs_consultant_hint: structuredResponse.needs_consultant_hint || false,
        line_proposals: results,
      },
      thinking: llmResp?.thinking || null,
      prompt_length: prompt.length,
      accounts_shown: accounts.length,
      categories_shown: categories.length,
      model_used: model,
      kb_notes_used: kbNoteTitles.length,
      agent_rules_used: agentRules.length,
      _debug: {
        prompt_sent: prompt,
        raw_response: llmResp?.text || null,
        model_used: model,
        agent_config_loaded: !!agentConfig,
        agent_rules_count: agentRules.length,
        kb_notes_used: kbNoteTitles.length,
        kb_note_titles: kbNoteTitles,
        company_ateco: companyAteco,
        accounts_by_section: Object.fromEntries(
          [...new Set((accounts as any[]).map(a => a.section))].map(s => [
            s, (accounts as any[]).filter(a => a.section === s).length,
          ])
        ),
        understandings_received: understandings.map(u => ({
          line_id: u.line_id,
          operation_type: u.operation_type,
          account_sections: u.account_sections,
          is_NOT: u.is_NOT,
        })),
        deterministic_matches_received: deterministicMatches.length,
        history_count: historySection ? historySection.split("\n").length : 0,
        memory_facts_count: memoryBlock ? memoryBlock.split("\n").length : 0,
        invoice_notes: invoiceNotes ? invoiceNotes.slice(0, 200) : null,
        invoice_causale: invoiceCausale ? invoiceCausale.slice(0, 200) : null,
        kb_chunks_used: kbChunkDebug.length,
        kb_chunks: kbChunkDebug,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
