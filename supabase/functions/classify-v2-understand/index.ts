// classify-v2-understand — Stage A: Comprehension
// "What is this operation?" — NO chart of accounts, NO classification.
// Returns: operation type, account section, is_NOT list, and reasoning for each line.
// This narrows the search space for Stage B (classify-v2-classify).
//
// v3: Reads agent_config, agent_rules, knowledge_base from Admin Panel DB.

import postgres from "npm:postgres@3.4.5";

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
  matched_groups: string[]; // from deterministic step
}

interface UnderstandingResult {
  line_id: string;
  operation_type: string;
  account_sections: string[];
  is_NOT: string[];
  reasoning: string;
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

/* ─── KB trigger matching (mirrors admin-test-classify) ── */

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

  // Generic rules (no specific triggers) are always included
  if (!hasAnyTrigger) return true;

  // Check ATECO prefix triggers
  if (rule.trigger_ateco_prefixes?.length > 0) {
    if (rule.trigger_ateco_prefixes.some((p) => companyAteco.startsWith(p))) return true;
  }

  // Check keyword triggers (any line description matches)
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

/* ─── Valid sections ─────────────────────── */

const ALL_SECTIONS = [
  "assets", "liabilities", "equity", "revenue",
  "cost_production", "cost_personnel", "depreciation", "other_costs",
  "financial", "extraordinary",
];

const SECTIONS_FOR_DIRECTION: Record<string, string[]> = {
  in: ["cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "assets", "liabilities"],
  out: ["revenue", "financial", "extraordinary", "assets", "liabilities"],
};

/* ─── Extract JSON array from text ───────── */

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
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
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const invoiceNotes = body.invoice_notes || null;
  const invoiceCausale = body.invoice_causale || null;

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // ─── Load Admin Panel infrastructure + context in parallel ──────
    const lineDescriptions = lines.map((l) => l.description || "");
    const vatKey = counterpartyVatKey
      ? counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "")
      : null;

    const [
      companyRows,
      agentConfigs,
      agentRules,
      counterpartyRows,
      groupRows,
    ] = await Promise.all([
      // Company ATECO + name
      sql`SELECT name, ateco_code FROM companies WHERE id = ${companyId} LIMIT 1`,
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
      // Counterparty ATECO info
      vatKey
        ? sql`SELECT ateco_code, ateco_description, business_sector, legal_type
              FROM counterparties
              WHERE company_id = ${companyId} AND vat_key = ${vatKey}
              LIMIT 1`
        : Promise.resolve([]),
      // Keyword group labels
      sql`SELECT group_code, group_name, keywords FROM operation_keyword_groups WHERE active = true`,
    ]);

    const companyName = companyRows[0]?.name || "";
    const companyAteco = companyRows[0]?.ateco_code || "";
    const atecoPrefix = companyAteco.slice(0, 2);
    const agentConfig = agentConfigs[0] || null;

    // Load knowledge_base (needs atecoPrefix from company query)
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

    console.log(`[understand] Admin Panel: config=${agentConfig ? "✓" : "✗"} rules=${agentRules.length} kb=${kbUsed.length}/${allKBRules.length}`);

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    const cp = counterpartyRows[0];
    if (cp) {
      const parts = [`P.IVA: ${counterpartyVatKey}`];
      if (cp.ateco_code) parts.push(`ATECO: ${cp.ateco_code} ${cp.ateco_description || ""}`);
      if (cp.business_sector) parts.push(`Settore: ${cp.business_sector}`);
      if (cp.legal_type) parts.push(`Tipo: ${cp.legal_type}`);
      counterpartyInfo += ` — ${parts.join(" — ")}`;
    }

    // Keyword group labels
    const allGroupCodes = [...new Set(lines.flatMap((l) => l.matched_groups || []))];
    const groupLabels: Record<string, string> = {};
    for (const g of groupRows) {
      if (allGroupCodes.includes(g.group_code)) {
        groupLabels[g.group_code] = g.group_name;
      }
    }

    // Valid sections for this direction
    const validSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];

    // Build line entries
    const lineEntries = lines.map((l, i) => {
      const groups = (l.matched_groups || []).map((c) => groupLabels[c] || c).join(", ");
      return `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}${groups ? ` GRUPPI_KEYWORD=[${groups}]` : ""}`;
    }).join("\n");

    // ─── Build prompt with Admin Panel data ──────────────────
    const promptParts: string[] = [];

    // 1. System prompt from agent_config (or fallback)
    if (agentConfig?.system_prompt) {
      promptParts.push(agentConfig.system_prompt);
      promptParts.push("");
    } else {
      promptParts.push("Sei un analista contabile italiano esperto.");
      promptParts.push("");
    }

    // 2. Agent rules (BEFORE context and lines)
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

    // 4. Company ATECO context
    promptParts.push("=== CONTESTO AZIENDA ===");
    promptParts.push(`Azienda: ${companyName}`);
    if (companyAteco) promptParts.push(`ATECO: ${companyAteco}`);
    promptParts.push("");

    // 5. Comprehension task
    promptParts.push(`CONTROPARTE: ${counterpartyInfo}`);
    promptParts.push(`DIREZIONE FATTURA: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}`);
    promptParts.push(`SEZIONI VALIDE: ${validSections.join(", ")}`);
    promptParts.push("");

    // Invoice notes + causale context
    if (invoiceNotes || invoiceCausale) {
      promptParts.push("=== INFORMAZIONI AGGIUNTIVE FATTURA ===");
      if (invoiceCausale) promptParts.push(`Causale fattura (dall'XML): ${invoiceCausale}`);
      if (invoiceNotes) promptParts.push(`Note utente: ${invoiceNotes}`);
      promptParts.push("Usa queste informazioni per capire meglio la natura dell'operazione.");
      promptParts.push("===");
      promptParts.push("");
    }
    promptParts.push(`IL TUO COMPITO: CAPIRE ogni riga di fattura — NON classificarla.

Per ogni riga, determina:
1. OPERATION_TYPE: descrizione breve (max 8 parole) dell'operazione economica. Es: "acquisto materiali edili", "servizio di trasporto conto terzi", "canone leasing escavatore"
2. ACCOUNT_SECTIONS: le 1-3 sezioni del piano dei conti dove si trova il conto corretto. Scegli tra: ${validSections.join(", ")}
   - REGOLA: per fatture passive, la maggior parte va in cost_production/other_costs. assets SOLO per beni strumentali > 516€. financial SOLO per interessi/commissioni bancarie.
   - REGOLA: per fatture attive, la maggior parte va in revenue.
3. IS_NOT: lista di 2-4 cose che questa riga NON è (anti-pattern per evitare errori comuni). Es: se è "trasporto pozzolana" → is_NOT: ["vendita di pozzolana", "acquisto di pozzolana", "noleggio mezzi"]. Se è "canone leasing" → is_NOT: ["acquisto bene strumentale", "rata mutuo", "noleggio"]
4. REASONING: ragionamento breve (max 20 parole)

ATTENZIONE AI GRUPPI KEYWORD: Se una riga ha GRUPPI_KEYWORD, quei gruppi ti dicono il tipo di operazione. Rispettali. Es: se GRUPPI_KEYWORD=[Vendita / Cessione], allora è una vendita, NON un acquisto.`);
    promptParts.push("");
    promptParts.push(`RIGHE:\n${lineEntries}`);
    promptParts.push("");
    promptParts.push(`Rispondi con un JSON array (no markdown):
[{"line_id":"uuid","operation_type":"...","account_sections":["section1"],"is_NOT":["non è X","non è Y"],"reasoning":"..."}]`);

    const prompt = promptParts.join("\n");

    // ─── Call Gemini (using config model/temperature/thinking) ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.1;
    const thinkingLevel = agentConfig?.thinking_level || "low";
    const thinkingBudget: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = thinkingBudget[thinkingLevel] ?? 1024;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: agentConfig?.max_output_tokens || 16384,
          temperature,
        },
        // thinkingConfig MUST be top-level, NOT nested inside generationConfig
        ...(budget > 0 ? { thinkingConfig: { thinkingBudget: budget } } : {}),
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await sql.end();
      return json({ error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const parts = (data as any)?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of parts) {
      if (part.text && !part.thought) responseText += part.text;
    }

    // Parse response — balanced extractor first, extractJson fallback
    let results: UnderstandingResult[] = [];
    const jsonStr = extractFirstJsonArray(responseText);
    const mapResult = (r: any) => ({
      line_id: r.line_id,
      operation_type: r.operation_type || "operazione generica",
      account_sections: (r.account_sections || []).filter((s: string) => ALL_SECTIONS.includes(s)),
      is_NOT: r.is_NOT || r.is_not || [],
      reasoning: r.reasoning || "",
    });
    if (jsonStr) {
      try {
        results = (JSON.parse(jsonStr) as any[]).map(mapResult);
      } catch (e) {
        console.error("[understand] JSON parse error:", e);
      }
    }
    if (results.length === 0) {
      try {
        const fallback = extractJson(responseText);
        results = (Array.isArray(fallback) ? fallback : [fallback]).map(mapResult);
        console.warn(`[understand] extractFirstJsonArray failed, extractJson fallback OK: ${results.length} items`);
      } catch { /* both failed */ }
    }

    // Ensure all lines have a result (fallback for missing)
    const resultMap = new Map(results.map((r) => [r.line_id, r]));
    const finalResults = lines.map((l) => {
      const existing = resultMap.get(l.line_id);
      if (existing) return existing;
      return {
        line_id: l.line_id,
        operation_type: "operazione generica",
        account_sections: direction === "in" ? ["cost_production", "other_costs"] : ["revenue"],
        is_NOT: [],
        reasoning: "Fallback — AI non ha restituito risultato per questa riga",
      };
    });

    await sql.end();

    return json({
      understandings: finalResults,
      prompt_length: prompt.length,
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
        company_sector: companyName,
        counterparty_info: counterpartyInfo,
        invoice_notes: invoiceNotes ? invoiceNotes.slice(0, 200) : null,
        invoice_causale: invoiceCausale ? invoiceCausale.slice(0, 200) : null,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
