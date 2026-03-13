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

interface KBRule {
  id: string;
  domain: string;
  audience: string;
  title: string;
  content: string;
  summary_structured?: Record<string, unknown> | null;
  applicability?: Record<string, unknown> | null;
  source_chunk_ids?: string[] | null;
  normativa_ref: string[];
  fiscal_values: Record<string, unknown>;
  trigger_keywords: string[];
  trigger_ateco_prefixes: string[];
  trigger_vat_natures: string[];
  trigger_doc_types: string[];
  ateco_scope: string[] | null;
  priority: number;
}

/* ─── KB trigger matching ────────────────── */

function matchesTriggers(
  rule: KBRule,
  companyAteco: string,
  lineDescriptions: string[],
): boolean {
  const hasAnyTrigger =
    (rule.trigger_keywords?.length > 0) ||
    (rule.trigger_vat_natures?.length > 0) ||
    (rule.trigger_doc_types?.length > 0) ||
    (rule.trigger_ateco_prefixes?.length > 0);

  if (!hasAnyTrigger) return true;

  if (rule.trigger_ateco_prefixes?.length > 0) {
    if (rule.trigger_ateco_prefixes.some((p) => companyAteco.startsWith(p))) return true;
  }

  if (rule.trigger_keywords?.length > 0) {
    const allText = lineDescriptions.join(" ").toLowerCase();
    if (rule.trigger_keywords.some((kw) => allText.includes(kw.toLowerCase()))) return true;
  }

  return false;
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

function formatKBRules(kbRules: KBRule[]): string {
  if (kbRules.length === 0) return "";
  const domainLabels: Record<string, string> = {
    iva: "IVA", ires_irap: "IRES/IRAP", ritenute: "Ritenute",
    classificazione: "Classificazione", settoriale: "Settoriale",
    operativo: "Operativo", aggiornamenti: "Aggiornamenti",
  };
  const lines: string[] = ["=== NORMATIVA E KNOWLEDGE BASE ==="];
  for (const r of kbRules) {
    const ref = r.normativa_ref?.length ? ` (Rif: ${r.normativa_ref.join(", ")})` : "";
    const summary = r.summary_structured && Object.keys(r.summary_structured).length > 0
      ? JSON.stringify(r.summary_structured)
      : r.content;
    const applicability = r.applicability && Object.keys(r.applicability).length > 0
      ? ` | Applicabilita: ${JSON.stringify(r.applicability)}`
      : "";
    lines.push(`[${domainLabels[r.domain] || r.domain}] ${r.title}: ${summary}${ref}${applicability}`);
  }
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

/* ─── Extract JSON array ─────────────────── */

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** Robust JSON extractor: handles markdown fences, arrays, and objects */
function extractJson(text: string): any {
  let clean = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(clean); } catch { /* continue */ }
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) try { return JSON.parse(arrMatch[0]); } catch { /* continue */ }
  const objMatch = clean.match(/\{[\s\S]*\}/);
  if (objMatch) try { return JSON.parse(objMatch[0]); } catch { /* continue */ }
  throw new Error("Cannot parse JSON from Gemini response");
}

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);

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
    const atecoPrefix = companyAteco.slice(0, 2);
    const agentConfig = agentConfigs[0] || null;
    const invoiceContractRefs = getInvoiceContractRefs(
      invoiceRow[0]?.primary_contract_ref || null,
      invoiceRow[0]?.contract_refs || null,
    );

    console.log(`[classify-v2] Loaded: ${accounts.length} accounts (ALL sections), ${categories.length} cats, ${articles.length} articles`);

    // Load knowledge_base (needs atecoPrefix)
    const allKBRules = await sql<KBRule[]>`
      SELECT id, domain, audience, title, content, summary_structured, applicability, source_chunk_ids, normativa_ref,
             fiscal_values, trigger_keywords, trigger_ateco_prefixes,
             trigger_vat_natures, trigger_doc_types, ateco_scope, priority
      FROM knowledge_base
      WHERE active = true AND status = 'approved'
        AND effective_from <= CURRENT_DATE AND effective_to >= CURRENT_DATE
        AND (ateco_scope IS NULL OR ${atecoPrefix} = ANY(ateco_scope))
      ORDER BY priority DESC
      LIMIT 50`;

    // Filter KB by audience + triggers
    const kbFiltered = allKBRules.filter((r) =>
      ["commercialista", "both"].includes(r.audience)
    );
    const kbMatched = kbFiltered.filter((r) =>
      matchesTriggers(r, companyAteco, lineDescriptions)
    );
    const kbUsed = kbMatched.slice(0, 30);

    console.log(`[classify-v2] Admin Panel: config=${agentConfig ? "✓" : "✗"} rules=${agentRules.length} kb=${kbUsed.length}/${allKBRules.length}`);

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyAtecoFull = "";
    let counterpartyLegalType = "";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cpRow] = await sql`
          SELECT ateco_code, ateco_description, business_sector, legal_type, address
          FROM counterparties WHERE company_id = ${companyId} AND vat_key = ${vatKey} LIMIT 1`;
        if (cpRow) {
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (cpRow.ateco_code) { parts.push(`ATECO: ${cpRow.ateco_code} ${cpRow.ateco_description || ""}`); counterpartyAtecoFull = cpRow.ateco_code; }
          if (cpRow.business_sector) parts.push(`Settore: ${cpRow.business_sector}`);
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
    try {
      const queryText = lines.map((l) => l.description).join(" | ") + ` | ${counterpartyName}`;
      const queryVec = await callGeminiEmbedding(geminiKey, queryText);
      const vecLiteral = toVectorLiteral(queryVec);
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
        [vecLiteral, companyId],
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

    // ─── RAG: Document chunks from kb_chunks ────────────────
    let documentChunksSection = "";
    let documentChunksDebug: { title: string; similarity: number }[] = [];
    try {
      // Reuse the same embedding we computed for memory (or compute if missing)
      const ragQueryText = lines.map((l) => l.description).join(" | ") + ` | ${counterpartyName}`;
      const ragVec = await callGeminiEmbedding(geminiKey, ragQueryText);
      const ragVecLiteral = toVectorLiteral(ragVec);

      const docChunks = await sql.unsafe(
        `SELECT kc.content, kc.section_title, kc.article_reference,
                kd.title AS doc_title,
                (1 - (kc.embedding <=> $1::halfvec(3072)))::float AS similarity
         FROM kb_chunks kc
         JOIN kb_documents kd ON kc.document_id = kd.id
         WHERE (kc.company_id IS NULL OR kc.company_id = $2)
           AND kd.status = 'ready'
         ORDER BY kc.embedding <=> $1::halfvec(3072)
         LIMIT 8`,
        [ragVecLiteral, companyId],
      );

      const relevantChunks = (docChunks as any[]).filter((c) => c.similarity >= 0.40);
      if (relevantChunks.length > 0) {
        const chunkLines = relevantChunks.slice(0, 5).map((c, i) => {
          const header = c.section_title || c.doc_title || "Documento";
          const ref = c.article_reference ? ` (Art. ${c.article_reference})` : "";
          const content = (c.content || "").slice(0, 1500);
          return `${i + 1}. [${header}${ref}] (sim=${c.similarity.toFixed(2)})\n${content}`;
        });
        documentChunksSection = `\n=== CONTESTO NORMATIVO (da documenti caricati) ===\n${chunkLines.join("\n\n")}\n===\n`;
        documentChunksDebug = relevantChunks.slice(0, 5).map((c) => ({
          title: c.section_title || c.doc_title || "N/D",
          similarity: c.similarity,
        }));
        console.log(`[classify-v2] RAG: ${relevantChunks.length} relevant chunks found (top sim=${relevantChunks[0].similarity.toFixed(3)})`);
      } else {
        console.log(`[classify-v2] RAG: no relevant chunks (best sim=${(docChunks as any[])[0]?.similarity?.toFixed(3) || "N/A"})`);
      }
    } catch (e) {
      console.warn("[classify-v2] RAG kb_chunks failed:", e);
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

    // 3. Knowledge base rules
    const kbBlock = formatKBRules(kbUsed);
    if (kbBlock) {
      promptParts.push(kbBlock);
      promptParts.push("");
    }

    // 3b. Document chunks (RAG)
    if (documentChunksSection) {
      promptParts.push(documentChunksSection);
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
Le evidenze di exact match, la memoria aziendale e la KB sono supporti al giudizio, non verdetti automatici.
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

    // ─── Call Gemini (using config model/temperature/thinking) ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.2;
    const thinkingLevel = agentConfig?.thinking_level || "medium";
    const thinkingBudget: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = agentConfig?.thinking_budget ?? thinkingBudget[thinkingLevel] ?? 8192;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: agentConfig?.max_output_tokens || 32768,
          temperature,
          ...(budget > 0 ? { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } : {}),
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await sql.end();
      return json({ error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const gParts = (data as any)?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    let thinkingText = "";
    for (const part of gParts) {
      if (part.thought && part.text) thinkingText += part.text;
      else if (part.text) responseText += part.text;
    }

    let structuredResponse: CommercialistaResponse = { line_proposals: [] };
    try {
      const parsed = extractJson(responseText);
      if (Array.isArray(parsed)) {
        structuredResponse = { line_proposals: parsed as ClassifyResult[] };
      } else if (parsed && typeof parsed === "object") {
        structuredResponse = {
          invoice_summary: typeof parsed.invoice_summary === "string" ? parsed.invoice_summary : null,
          evidence_refs: Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs as string[] : [],
          needs_consultant_hint: Boolean(parsed.needs_consultant_hint),
          line_proposals: Array.isArray(parsed.line_proposals) ? parsed.line_proposals as ClassifyResult[] : [],
        };
      }
    } catch (e) {
      console.error("[classify-v2] JSON parse error:", e);
    }

    let results: ClassifyResult[] = structuredResponse.line_proposals || [];
    if (results.length === 0) {
      const jsonStr = extractFirstJsonArray(responseText);
      if (jsonStr) {
        try {
          results = JSON.parse(jsonStr);
          structuredResponse.line_proposals = results;
        } catch { /* ignore */ }
      }
    }

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
      thinking: thinkingText || null,
      prompt_length: prompt.length,
      accounts_shown: accounts.length,
      categories_shown: categories.length,
      model_used: model,
      kb_rules_used: kbUsed.length,
      agent_rules_used: agentRules.length,
      _debug: {
        prompt_sent: prompt,
        raw_response: responseText,
        model_used: model,
        agent_config_loaded: !!agentConfig,
        agent_rules_count: agentRules.length,
        kb_rules_count: kbUsed.length,
        kb_rules_titles: kbUsed.map((r: any) => r.title),
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
        document_chunks_found: documentChunksDebug.length,
        document_chunks: documentChunksDebug,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
