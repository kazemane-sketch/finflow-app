// classify-v2-classify — Stage B: Classification
// Takes understanding results from Stage A and assigns account, category, article.
// Only sees FILTERED chart of accounts (by section from Stage A).
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
  suggest_new_account?: {
    code: string; name: string; section: string; parent_code: string; reason: string;
  } | null;
  suggest_new_category?: {
    name: string; type: string; reason: string;
  } | null;
}

/* ─── Admin Panel types ─────────────────── */

interface AgentConfig {
  agent_type: string;
  system_prompt: string;
  model: string;
  temperature: number;
  thinking_level: string;
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
    lines.push(`[${domainLabels[r.domain] || r.domain}] ${r.title}: ${r.content}${ref}`);
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
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const understandings = body.understandings || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // Build understanding map
    const underMap = new Map(understandings.map((u) => [u.line_id, u]));

    // Collect all needed sections from understandings
    const neededSections = new Set<string>();
    const dirSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];
    for (const u of understandings) {
      for (const s of u.account_sections) {
        if (dirSections.allowed.includes(s)) neededSections.add(s);
      }
    }
    if (neededSections.size === 0) {
      for (const s of dirSections.allowed) neededSections.add(s);
    }

    const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
    const lineDescriptions = lines.map((l) => l.description || "");

    // ─── Load context + Admin Panel infrastructure in parallel ──────
    const [articles, categories, accounts, phases, companyRow, agentConfigs, agentRules] = await Promise.all([
      sql`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true AND type = ANY(${allowedCatTypes}::text[]) ORDER BY sort_order, name`,
      sql`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false AND section = ANY(${[...neededSections]}::text[]) ORDER BY code`,
      sql`SELECT id, article_id, code, name, phase_type, is_counting_point, invoice_direction FROM article_phases WHERE company_id = ${companyId} AND active = true ORDER BY article_id, sort_order`,
      sql`SELECT name, vat_number, ateco_code FROM companies WHERE id = ${companyId} LIMIT 1`,
      // Agent config for commercialista
      sql<AgentConfig[]>`
        SELECT agent_type, system_prompt, model, temperature, thinking_level, max_output_tokens
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

    console.log(`[classify-v2] Loaded: ${accounts.length} accounts (sections: ${[...neededSections].join(",")}), ${categories.length} cats, ${articles.length} articles`);

    // Load knowledge_base (needs atecoPrefix)
    const allKBRules = await sql<KBRule[]>`
      SELECT id, domain, audience, title, content, normativa_ref,
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
        `SELECT fact_text, fact_type, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
         FROM company_memory
         WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec(3072) LIMIT 10`,
        [vecLiteral, companyId],
      );
      const memFacts = (memRows as any[]).filter((m) => m.similarity >= 0.40)
        .map((m) => ({ fact_text: m.fact_text, fact_type: m.fact_type }));
      memoryBlock = getCompanyMemoryBlock(memFacts);
    } catch (e) {
      console.warn("[classify-v2] Memory embedding failed:", e);
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
      const uCtx = u ? ` → COMPRENSIONE: "${u.operation_type}" sections=${u.account_sections.join(",")}${u.is_NOT.length ? ` NOT=[${u.is_NOT.join("; ")}]` : ""}` : "";
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}${uCtx}`;
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

    // 4. Company + counterparty context
    promptParts.push("=== CONTESTO AZIENDA ===");
    promptParts.push(`AZIENDA: ${companyName} (P.IVA: ${companyVat})`);
    if (companyAteco) promptParts.push(`ATECO: ${companyAteco}`);
    promptParts.push(`CONTROPARTE: ${counterpartyInfo}`);
    promptParts.push(`DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}`);
    promptParts.push("");

    // 5. User instructions + memory
    if (userInstructionsBlock) promptParts.push(userInstructionsBlock);
    if (memoryBlock) promptParts.push(memoryBlock);
    promptParts.push("");

    // 6. Comprehension context
    promptParts.push(`IMPORTANTE — COMPRENSIONE (Stage A):
Ogni riga ha una "COMPRENSIONE" allegata che ti dice cos'è l'operazione e in quali sezioni cercare il conto.
RISPETTA le sezioni indicate. Se la comprensione dice sections=cost_production, NON scegliere conti in assets.
Se la comprensione dice NOT=["vendita di pozzolana"], allora NON classificare come vendita.`);
    promptParts.push("");

    // 7. Charts of accounts, categories, articles
    promptParts.push(`CATEGORIE:\n${catSection}`);
    promptParts.push("");
    promptParts.push(`CONTI (filtrati per le sezioni rilevanti):\n${accSection}`);
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

Rispondi con JSON array (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","confidence":0-100,"reasoning":"max 30 parole","fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]`);

    const prompt = promptParts.join("\n");

    // ─── Call Gemini (using config model/temperature/thinking) ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.2;
    const thinkingLevel = agentConfig?.thinking_level || "medium";
    const thinkingBudget: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = thinkingBudget[thinkingLevel] ?? 8192;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: agentConfig?.max_output_tokens || 32768,
          temperature,
          ...(budget > 0 ? { thinkingConfig: { thinkingBudget: budget } } : {}),
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
    for (const part of gParts) { if (part.text && !part.thought) responseText += part.text; }

    const jsonStr = extractFirstJsonArray(responseText);
    let results: ClassifyResult[] = [];
    if (jsonStr) {
      try {
        results = JSON.parse(jsonStr);
      } catch (e) {
        console.error("[classify-v2] JSON parse error:", e);
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
    }

    await sql.end();

    return json({
      classifications: results,
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
        history_count: historySection ? historySection.split("\n").length : 0,
        memory_facts_count: memoryBlock ? memoryBlock.split("\n").length : 0,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
