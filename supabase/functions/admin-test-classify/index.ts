// supabase/functions/admin-test-classify/index.ts
// Sandbox agent execution for admin Test Lab
// PRIVACY: NEVER reads company-scoped data (invoices, counterparties, companies, etc.)
// PRIVACY: NEVER writes anything to the DB — pure read-only for agent_config, agent_rules, knowledge_base

import postgres from "npm:postgres@3.4.5";

/* ─── CORS ───────────────────────────────── */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─── Helpers ────────────────────────────── */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

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
    if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/* ─── Types ──────────────────────────────── */
interface AgentConfig {
  agent_type: string;
  display_name: string;
  system_prompt: string;
  model: string;
  model_escalation: string | null;
  temperature: number;
  thinking_level: string;
  max_output_tokens: number;
}

interface AgentRule {
  title: string;
  rule_text: string;
  trigger_condition: string | null;
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

interface TestLine {
  line_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  vat_rate: number;
  vat_nature: string;
}

interface RequestBody {
  agent_type: "commercialista" | "revisore" | "both";
  test_context: {
    company_ateco: string;
    company_sector: string;
    company_name: string;
  };
  invoice_data: {
    direction: "in" | "out";
    doc_type: string;
    counterparty_name: string;
    counterparty_vat: string;
    total_amount: number;
    notes: string;
  };
  lines: TestLine[];
}

/* ─── Gemini call ────────────────────────── */

// Model pricing per 1M tokens
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
};

async function callGemini(
  geminiKey: string,
  config: AgentConfig,
  prompt: string,
): Promise<{
  thinking: string;
  raw_response: string;
  timing_ms: number;
  prompt_tokens_est: number;
  response_tokens_est: number;
  estimated_cost_usd: number;
  model_used: string;
}> {
  const model = config.model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  // Determine thinking config
  const thinkingLevel = config.thinking_level || "medium";
  const thinkingBudget: Record<string, number> = {
    none: 0,
    low: 1024,
    medium: 8192,
    high: 24576,
  };
  const budget = thinkingBudget[thinkingLevel] ?? 8192;

  const requestBody: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: config.temperature ?? 0.1,
      maxOutputTokens: config.max_output_tokens || 8192,
      ...(budget > 0
        ? {
            thinkingConfig: {
              thinkingBudget: budget,
            },
          }
        : {}),
    },
  };

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const timing_ms = Date.now() - t0;

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(
      `Gemini error (${model}): ${payload?.error?.message || `HTTP ${res.status}`}`,
    );
  }

  // Extract thinking and response from parts
  let thinking = "";
  let raw_response = "";
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.thought === true && part.text) {
      thinking += part.text;
    } else if (part.text) {
      raw_response += part.text;
    }
  }

  // Estimate tokens
  const prompt_tokens_est = Math.ceil(prompt.length / 4);
  const response_tokens_est = Math.ceil(
    (raw_response.length + thinking.length) / 4,
  );

  // Estimate cost
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gemini-2.5-flash"];
  const estimated_cost_usd =
    (prompt_tokens_est * pricing.input + response_tokens_est * pricing.output) /
    1_000_000;

  return {
    thinking,
    raw_response,
    timing_ms,
    prompt_tokens_est,
    response_tokens_est,
    estimated_cost_usd: Math.round(estimated_cost_usd * 1_000_000) / 1_000_000,
    model_used: model,
  };
}

/* ─── Prompt builders ────────────────────── */

function buildCommercialistaPrompt(
  config: AgentConfig,
  agentRules: AgentRule[],
  kbRules: KBRule[],
  body: RequestBody,
): string {
  const lines: string[] = [];

  // System prompt from agent_config
  lines.push(config.system_prompt);
  lines.push("");

  // Agent rules
  if (agentRules.length > 0) {
    lines.push("=== REGOLE OPERATIVE ===");
    agentRules.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}] — ${r.rule_text}`);
    });
    lines.push("");
  }

  // Knowledge base rules grouped by domain
  if (kbRules.length > 0) {
    lines.push("=== NORMATIVA E KNOWLEDGE BASE ===");
    const byDomain = new Map<string, KBRule[]>();
    for (const r of kbRules) {
      const arr = byDomain.get(r.domain) || [];
      arr.push(r);
      byDomain.set(r.domain, arr);
    }
    const domainLabels: Record<string, string> = {
      iva: "IVA",
      ires_irap: "IRES/IRAP",
      ritenute: "Ritenute",
      classificazione: "Classificazione",
      settoriale: "Settoriale",
      operativo: "Operativo",
      aggiornamenti: "Aggiornamenti",
    };
    for (const [domain, rules] of byDomain) {
      for (const r of rules) {
        const ref = r.normativa_ref?.length
          ? ` (Rif: ${r.normativa_ref.join(", ")})`
          : "";
        lines.push(
          `[${domainLabels[domain] || domain}] ${r.title}: ${r.content}${ref}`,
        );
      }
    }
    lines.push("");
  }

  // Test context
  lines.push("=== CONTESTO AZIENDA (TEST) ===");
  lines.push(`Azienda: ${body.test_context.company_name}`);
  lines.push(`ATECO: ${body.test_context.company_ateco}`);
  lines.push(`Settore: ${body.test_context.company_sector}`);
  lines.push(
    "NOTA: contesto di test senza storico, memory o piano dei conti specifico. Classifica basandoti sulle regole fornite e sulla tua competenza contabile.",
  );
  lines.push("");

  // Counterparty
  lines.push("=== CONTROPARTE ===");
  lines.push(`Nome: ${body.invoice_data.counterparty_name}`);
  lines.push(`P.IVA: ${body.invoice_data.counterparty_vat}`);
  lines.push("");

  // Invoice
  lines.push("=== FATTURA ===");
  lines.push(`Tipo: ${body.invoice_data.doc_type}`);
  lines.push(
    `Direzione: ${body.invoice_data.direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}`,
  );
  lines.push(`Importo totale: €${body.invoice_data.total_amount}`);
  if (body.invoice_data.notes) {
    lines.push(`Note/Causali: ${body.invoice_data.notes}`);
  }
  lines.push("");

  // Lines
  lines.push("=== RIGHE DA CLASSIFICARE ===");
  body.lines.forEach((l, i) => {
    let lineStr = `${i + 1}. [${l.line_id}] "${l.description}" qty=${l.quantity} prezzo_unit=${l.unit_price} tot=${l.total_price} IVA=${l.vat_rate}%`;
    if (l.vat_nature) lineStr += ` natura=${l.vat_nature}`;
    lines.push(lineStr);
  });
  lines.push("");

  // Output format
  lines.push("=== FORMATO OUTPUT ===");
  lines.push(
    "Rispondi SOLO con un JSON array, nessun testo prima o dopo.",
  );
  lines.push("Per ogni riga:");
  lines.push(
    `[{"line_id":"...","account_suggestion":"nome conto appropriato","account_section":"cost_production|cost_personnel|revenue|financial|assets|liabilities|depreciation|other_costs|extraordinary","category_suggestion":"nome categoria","article_suggestion":"nome articolo o null","cost_center_hint":"indicazione CdC o null","confidence":0-100,"reasoning":"spiegazione max 50 parole","fiscal_flags":{"deducibilita_pct":100,"iva_detraibilita_pct":100,"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"note":null}}]`,
  );
  lines.push(
    "NOTA: non hai UUID di conti/categorie reali. Usa nomi descrittivi italiani.",
  );

  return lines.join("\n");
}

function buildRevisorePrompt(
  config: AgentConfig,
  agentRules: AgentRule[],
  kbRules: KBRule[],
  body: RequestBody,
  commercialistaOutput: unknown[] | null,
): string {
  const lines: string[] = [];

  // System prompt
  lines.push(config.system_prompt);
  lines.push("");

  // Agent rules
  if (agentRules.length > 0) {
    lines.push("=== REGOLE OPERATIVE ===");
    agentRules.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.title}] — ${r.rule_text}`);
    });
    lines.push("");
  }

  // KB rules filtered for revisore
  if (kbRules.length > 0) {
    lines.push("=== NORMATIVA E KNOWLEDGE BASE ===");
    const domainLabels: Record<string, string> = {
      iva: "IVA",
      ires_irap: "IRES/IRAP",
      ritenute: "Ritenute",
      classificazione: "Classificazione",
      settoriale: "Settoriale",
      operativo: "Operativo",
      aggiornamenti: "Aggiornamenti",
    };
    for (const r of kbRules) {
      const ref = r.normativa_ref?.length
        ? ` (Rif: ${r.normativa_ref.join(", ")})`
        : "";
      lines.push(
        `[${domainLabels[r.domain] || r.domain}] ${r.title}: ${r.content}${ref}`,
      );
    }
    lines.push("");
  }

  // Test context
  lines.push("=== CONTESTO AZIENDA (TEST) ===");
  lines.push(`ATECO azienda: ${body.test_context.company_ateco}`);
  lines.push(`Settore: ${body.test_context.company_sector}`);
  lines.push("");

  // Counterparty
  lines.push("=== CONTROPARTE ===");
  lines.push(`Nome: ${body.invoice_data.counterparty_name}`);
  lines.push(`P.IVA: ${body.invoice_data.counterparty_vat}`);
  lines.push("");

  // Commercialista output (if chain mode)
  if (commercialistaOutput && Array.isArray(commercialistaOutput)) {
    lines.push("=== CLASSIFICAZIONE DEL COMMERCIALISTA (da verificare) ===");
    for (const item of commercialistaOutput) {
      const r = item as Record<string, unknown>;
      const flags = r.fiscal_flags as Record<string, unknown> | undefined;
      lines.push(
        `Riga ${r.line_id}: "${body.lines.find((l) => l.line_id === r.line_id)?.description || "?"}" → conto: ${r.account_suggestion}, conf: ${r.confidence}%, flags: deduc=${flags?.deducibilita_pct ?? "?"}%, iva=${flags?.iva_detraibilita_pct ?? "?"}%`,
      );
    }
    lines.push("");
  }

  // Original invoice lines
  lines.push("=== RIGHE FATTURA ORIGINALI ===");
  body.lines.forEach((l, i) => {
    let lineStr = `${i + 1}. [${l.line_id}] "${l.description}" qty=${l.quantity} prezzo_unit=${l.unit_price} tot=${l.total_price} IVA=${l.vat_rate}%`;
    if (l.vat_nature) lineStr += ` natura=${l.vat_nature}`;
    lines.push(lineStr);
  });
  lines.push("");

  // Output format
  lines.push("=== IL TUO COMPITO ===");
  lines.push(
    "Per ogni riga, rivedi SOLO la fiscalità. Restituisci un JSON array:",
  );
  lines.push(
    `[{"line_id":"...","fiscal_flags":{"deducibilita_pct":...,"iva_detraibilita_pct":...,"ritenuta_acconto":{"aliquota":20,"base":"imponibile"}|null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"note":"eventuale nota"},"alerts":[{"type":"deducibilita|ritenuta|reverse_charge|inerenza|bene_strumentale|general","severity":"warning|info","title":"...","description":"...","options":["Opzione A","Opzione B"]}],"confidence":0-100,"reasoning":"spiegazione revisione"}]`,
  );
  lines.push("Se non ci sono alert: alerts = []");

  return lines.join("\n");
}

/* ─── KB rule trigger matching ───────────── */

function matchesTriggers(
  rule: KBRule,
  body: RequestBody,
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
    const ateco = body.test_context.company_ateco;
    if (rule.trigger_ateco_prefixes.some((p) => ateco.startsWith(p))) return true;
  }

  // Check doc_type triggers
  if (rule.trigger_doc_types?.length > 0) {
    if (rule.trigger_doc_types.includes(body.invoice_data.doc_type)) return true;
  }

  // Check VAT nature triggers (any line matches)
  if (rule.trigger_vat_natures?.length > 0) {
    for (const line of body.lines) {
      if (line.vat_nature && rule.trigger_vat_natures.some((n) =>
        line.vat_nature.startsWith(n) || line.vat_nature === n
      )) return true;
    }
  }

  // Check keyword triggers (any line description matches)
  if (rule.trigger_keywords?.length > 0) {
    const allText = body.lines
      .map((l) => l.description)
      .join(" ")
      .toLowerCase();
    if (rule.trigger_keywords.some((kw) => allText.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/* ─── Main handler ───────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL not configured" }, 500);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY not configured" }, 500);

  // 1. Verify caller is platform admin
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Non autorizzato" }, 401);

  let userId: string;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    userId = payload.sub;
    if (!userId) throw new Error("no sub");
  } catch {
    return json({ error: "Token JWT invalido" }, 401);
  }

  const sql = postgres(dbUrl, { max: 2 });
  try {
    const [admin] = await sql`
      SELECT 1 FROM platform_admins WHERE user_id = ${userId}
    `;
    if (!admin) {
      await sql.end();
      return json({ error: "Non sei un platform admin" }, 403);
    }

    // 2. Parse request body
    const body: RequestBody = await req.json();
    if (!body.agent_type || !body.lines?.length) {
      await sql.end();
      return json({ error: "agent_type e lines sono obbligatori" }, 400);
    }

    const agentTypes: string[] =
      body.agent_type === "both"
        ? ["commercialista", "revisore"]
        : [body.agent_type];

    // 3. Load agent configs
    const configs = await sql<AgentConfig[]>`
      SELECT agent_type, display_name, system_prompt, model, model_escalation,
             temperature, thinking_level, max_output_tokens
      FROM agent_config WHERE active = true
    `;
    const configMap = new Map(configs.map((c) => [c.agent_type, c]));

    // 4. Load agent rules
    const allAgentRules = await sql<AgentRule[]>`
      SELECT agent_type, title, rule_text, trigger_condition, trigger_keywords, sort_order
      FROM agent_rules WHERE active = true
      ORDER BY sort_order
    `;

    // 5. Load KB rules (pre-filter by date and ATECO scope)
    const atecoPrefix = body.test_context.company_ateco?.slice(0, 2) || "";
    const allKBRules = await sql<KBRule[]>`
      SELECT id, domain, audience, title, content, normativa_ref,
             fiscal_values, trigger_keywords, trigger_ateco_prefixes,
             trigger_vat_natures, trigger_doc_types, ateco_scope, priority
      FROM knowledge_base
      WHERE active = true AND status = 'approved'
        AND effective_from <= CURRENT_DATE AND effective_to >= CURRENT_DATE
        AND (ateco_scope IS NULL OR ${atecoPrefix} = ANY(ateco_scope))
      ORDER BY priority DESC
      LIMIT 50
    `;

    // Results container
    const result: Record<string, unknown> = {
      agents: {} as Record<string, unknown>,
      knowledge_rules_used: [] as unknown[],
      agent_rules_used: [] as unknown[],
    };

    let commercialistaParsed: unknown[] | null = null;

    for (const agentType of agentTypes) {
      const config = configMap.get(agentType);
      if (!config) {
        (result.agents as Record<string, unknown>)[agentType] = {
          error: `Agent config non trovato per '${agentType}'`,
        };
        continue;
      }

      // Filter agent rules for this agent
      const rules = allAgentRules.filter(
        (r) => (r as unknown as Record<string, string>).agent_type === agentType,
      );

      // Filter KB rules for this agent's audience
      const audienceFilter = agentType === "commercialista"
        ? ["commercialista", "both"]
        : ["revisore", "both"];
      const kbCandidates = allKBRules.filter((r) =>
        audienceFilter.includes(r.audience)
      );

      // Further filter by trigger matching
      const kbMatched = kbCandidates.filter((r) => matchesTriggers(r, body));
      // Limit to 30 rules
      const kbUsed = kbMatched.slice(0, 30);

      // Build prompt
      let prompt: string;
      if (agentType === "commercialista") {
        prompt = buildCommercialistaPrompt(config, rules, kbUsed, body);
      } else {
        prompt = buildRevisorePrompt(
          config,
          rules,
          kbUsed,
          body,
          commercialistaParsed,
        );
      }

      // Call Gemini
      const geminiResult = await callGemini(geminiKey, config, prompt);

      // Parse response
      const jsonStr = extractFirstJsonArray(geminiResult.raw_response);
      let parsed_result: unknown[] = [];
      if (jsonStr) {
        try {
          parsed_result = JSON.parse(jsonStr);
        } catch {
          parsed_result = [];
        }
      }

      // Store for chain mode
      if (agentType === "commercialista") {
        commercialistaParsed = parsed_result;
      }

      (result.agents as Record<string, unknown>)[agentType] = {
        prompt_sent: prompt,
        thinking: geminiResult.thinking,
        raw_response: geminiResult.raw_response,
        parsed_result,
        model_used: geminiResult.model_used,
        thinking_level: config.thinking_level,
        timing_ms: geminiResult.timing_ms,
        prompt_tokens_est: geminiResult.prompt_tokens_est,
        response_tokens_est: geminiResult.response_tokens_est,
        estimated_cost_usd: geminiResult.estimated_cost_usd,
      };

      // Track rules used (for first agent or merge)
      if (agentType === agentTypes[0]) {
        (result as Record<string, unknown>).knowledge_rules_used = kbUsed.map(
          (r) => ({ id: r.id, domain: r.domain, title: r.title, priority: r.priority }),
        );
        (result as Record<string, unknown>).agent_rules_used = rules.map(
          (r) => ({ title: r.title, sort_order: r.sort_order }),
        );
      }
    }

    await sql.end();
    return json(result);
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
