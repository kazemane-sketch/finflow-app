// fiscal-reviewer — Fiscal Review Agent (Revisore)
// Reviews ALL classified lines (from both deterministic + AI) and produces:
// 1. Validated/corrected fiscal_flags per line
// 2. Invoice-level fiscal alerts (notes) for user decisions
//
// v3: Reads agent_config, agent_rules, knowledge_base from Admin Panel DB.
//     Uses thinking_level from config for thorough fiscal analysis.
//     Pre-applies fiscal_decisions (user choices on past alerts) from Fase 3.

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

interface ClassifiedLine {
  line_id: string;
  description: string;
  total_price: number | null;
  category_name: string | null;
  account_code: string | null;
  account_name: string | null;
  confidence: number;
  fiscal_flags: {
    ritenuta_acconto: { aliquota: number; base: string } | null;
    reverse_charge: boolean;
    split_payment: boolean;
    bene_strumentale: boolean;
    deducibilita_pct: number;
    iva_detraibilita_pct: number;
    note: string | null;
  };
  source: string; // "rule" | "history" | "ai"
  fiscal_flags_source?: string; // "rule_confirmed" | "to_review"
  fiscal_flags_preset?: Record<string, unknown> | null;
}

interface FiscalAlert {
  type: string;
  severity: "warning" | "info";
  title: string;
  description: string;
  current_choice: string;
  options: { label: string; fiscal_override: Record<string, unknown>; is_default: boolean }[];
  affected_lines: string[];
}

interface ReviewResult {
  line_id: string;
  fiscal_flags_corrected: ClassifiedLine["fiscal_flags"];
  issues: string[];
  confidence_adjustment: number;
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
    let entry = `[${domainLabels[r.domain] || r.domain}] ${r.title}: ${r.content}${ref}`;
    // Include fiscal_values if available (important for the reviewer)
    if (r.fiscal_values && Object.keys(r.fiscal_values).length > 0) {
      entry += ` | Valori: ${JSON.stringify(r.fiscal_values)}`;
    }
    lines.push(entry);
  }
  return lines.join("\n");
}

/* ─── Helpers ────────────────────────────── */

function extractJsonSection(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  const afterMarker = text.slice(idx + marker.length);
  const start = afterMarker.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < afterMarker.length; i++) {
    const ch = afterMarker[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return afterMarker.slice(start, i + 1); }
  }
  return null;
}

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

/* ─── Subject keyword extraction (mirrors frontend) ── */

const STOPWORDS = new Set([
  "per", "con", "del", "della", "dei", "delle", "dal", "dalla",
  "nel", "nella", "sul", "sulla", "che", "non", "una", "uno",
  "gli", "alla", "alle", "tra", "fra", "come", "anche", "più",
  "rif", "vostro", "nostro", "sig", "spett", "fattura", "fatt",
  "numero", "num", "art", "cod", "tipo", "data", "periodo",
  "mese", "anno", "totale", "importo", "prezzo", "costo",
  "netto", "lordo", "iva", "inclusa", "esclusa",
]);

function extractSubjectKeywords(description: string): string[] {
  let desc = description.toLowerCase();
  desc = desc.replace(/\b[a-z]{2}\d{3}[a-z]{2}\b/gi, "");
  desc = desc.replace(/\b\d+([.,]\d+)?\s*(eur|euro|€|kg|lt|ton|pz|nr|q\.li)?\b/gi, "");
  desc = desc.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "");
  desc = desc.replace(/[,;:()[\]{}'"/\\.\-]/g, " ");
  desc = desc.replace(/\s+/g, " ").trim();
  const words = desc.split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

function findBestOperationGroup(
  descLower: string,
  groups: { group_code: string; keywords: string[] }[],
): string | null {
  let bestCode: string | null = null;
  let bestLen = 0;
  for (const g of groups) {
    for (const kw of g.keywords as string[]) {
      const kwLower = kw.toLowerCase();
      if (descLower.includes(kwLower) && kwLower.length > bestLen) {
        bestCode = g.group_code;
        bestLen = kwLower.length;
      }
    }
  }
  return bestCode;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
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
    lines?: ClassifiedLine[];
    direction?: string;
    counterparty_name?: string;
    counterparty_vat_key?: string;
    contract_refs?: string[];
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const lines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyName = body.counterparty_name || "N.D.";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const contractRefs = body.contract_refs || [];

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (lines.length === 0) return json({ error: "lines vuote" }, 400);

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // ─── Load Admin Panel infrastructure + counterparty info in parallel ──
    const lineDescriptions = lines.map((l) => l.description || "");
    let vatKey: string | null = null;
    if (counterpartyVatKey) {
      vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
    }

    const [
      companyRows,
      agentConfigs,
      agentRules,
      counterpartyRows,
    ] = await Promise.all([
      // Company ATECO + name
      sql`SELECT name, ateco_code FROM companies WHERE id = ${companyId} LIMIT 1`,
      // Agent config for revisore
      sql<AgentConfig[]>`
        SELECT agent_type, system_prompt, model, temperature, thinking_level, max_output_tokens
        FROM agent_config WHERE active = true AND agent_type = 'revisore'
        LIMIT 1`,
      // Agent rules for revisore
      sql<AgentRule[]>`
        SELECT title, rule_text, trigger_keywords, sort_order
        FROM agent_rules WHERE active = true AND agent_type = 'revisore'
        ORDER BY sort_order`,
      // Counterparty info
      vatKey
        ? sql`SELECT ateco_code, ateco_description, legal_type, business_sector
              FROM counterparties WHERE company_id = ${companyId} AND vat_key = ${vatKey} LIMIT 1`
        : Promise.resolve([]),
    ]);

    const companyName = companyRows[0]?.name || "";
    const companyAteco = companyRows[0]?.ateco_code || "";
    const atecoPrefix = companyAteco.slice(0, 2);
    const agentConfig = agentConfigs[0] || null;

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyLegalType = "";
    let counterpartyAteco = "";
    const cpRow = counterpartyRows[0];
    if (cpRow) {
      counterpartyLegalType = cpRow.legal_type || "";
      counterpartyAteco = cpRow.ateco_code || "";
      const parts = [`P.IVA: ${counterpartyVatKey}`];
      if (cpRow.ateco_code) parts.push(`ATECO: ${cpRow.ateco_code} ${cpRow.ateco_description || ""}`);
      if (cpRow.legal_type) parts.push(`Tipo: ${cpRow.legal_type}`);
      if (cpRow.business_sector) parts.push(`Settore: ${cpRow.business_sector}`);
      counterpartyInfo += ` — ${parts.join(" — ")}`;
    }

    // ─── Load knowledge_base (NEW: replaces old fiscal_knowledge RAG) ──
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

    // Filter KB by audience (revisore + both) + triggers
    const kbFiltered = allKBRules.filter((r) =>
      ["revisore", "both"].includes(r.audience)
    );
    const kbMatched = kbFiltered.filter((r) =>
      matchesTriggers(r, companyAteco, lineDescriptions)
    );
    const kbUsed = kbMatched.slice(0, 30);

    console.log(`[fiscal-reviewer] Admin Panel: config=${agentConfig ? "✓" : "✗"} rules=${agentRules.length} kb=${kbUsed.length}/${allKBRules.length}`);

    // ─── Pre-resolve fiscal decisions (Fase 3 — preserved) ──────────
    const preResolvedFiscal = new Map<string, {
      alert_type: string;
      fiscal_override: Record<string, unknown>;
      chosen_option: string;
      times_applied: number;
    }[]>();

    if (vatKey) {
      const fiscalDecisions = await sql`
        SELECT id, operation_group_code, subject_keywords, alert_type,
               chosen_option_label, fiscal_override, times_applied,
               contract_ref, account_id
        FROM fiscal_decisions
        WHERE company_id = ${companyId}
          AND counterparty_vat_key = ${vatKey}
          AND direction = ${direction}`;

      if (fiscalDecisions.length > 0) {
        const opGroups = await sql`
          SELECT group_code, keywords FROM operation_keyword_groups WHERE active = true`;

        for (const line of lines) {
          const descLower = line.description.toLowerCase();
          const lineGroupCode = findBestOperationGroup(descLower, opGroups);
          if (!lineGroupCode) continue;

          const lineSubjectKw = extractSubjectKeywords(line.description);
          const lineSubjectSet = new Set(lineSubjectKw);

          const lineDecisions: typeof preResolvedFiscal extends Map<string, infer V> ? V : never = [];

          for (const dec of fiscalDecisions) {
            if (dec.operation_group_code !== lineGroupCode) continue;

            // Contract ref compatibility: if the decision has a contract_ref,
            // the invoice MUST have the same ref
            if (dec.contract_ref) {
              if (!contractRefs.includes(dec.contract_ref)) continue;
            }

            // Account ID compatibility: if the decision has an account_id,
            // the line must have the same account
            if (dec.account_id) {
              const lineAccCode = line.account_code;
              // We don't have account_id directly on the line, but we skip
              // if the decision is account-specific (downstream will match via frontend)
              // For now, skip this check in the edge function since we don't have line account_id
            }

            const decSubjectSet = new Set((dec.subject_keywords as string[]) || []);
            const jaccard = jaccardSimilarity(lineSubjectSet, decSubjectSet);
            if (jaccard < 0.80) continue;

            lineDecisions.push({
              alert_type: dec.alert_type,
              fiscal_override: dec.fiscal_override as Record<string, unknown>,
              chosen_option: dec.chosen_option_label,
              times_applied: dec.times_applied,
            });

            sql`UPDATE fiscal_decisions SET times_applied = times_applied + 1, last_applied_at = now() WHERE id = ${dec.id}`.catch(() => {});
          }

          if (lineDecisions.length > 0) {
            preResolvedFiscal.set(line.line_id, lineDecisions);
          }
        }
      }
    }

    // ─── Build pre-resolved section for prompt ────────────────
    let preResolvedSection = "";
    const preResolvedLineIds = new Set<string>();
    const preResolvedAlertTypes = new Map<string, Set<string>>();

    if (preResolvedFiscal.size > 0) {
      const preLines: string[] = [];
      for (const [lineId, decs] of preResolvedFiscal) {
        const line = lines.find((l) => l.line_id === lineId);
        if (!line) continue;
        preResolvedLineIds.add(lineId);
        const alertTypes = new Set<string>();
        for (const d of decs) {
          alertTypes.add(d.alert_type);
          preLines.push(
            `- [${lineId}] "${line.description.slice(0, 80)}" → ${d.alert_type}: ${d.chosen_option} (applicata ${d.times_applied} volte)`
          );
        }
        preResolvedAlertTypes.set(lineId, alertTypes);
      }
      preResolvedSection = `\n=== DECISIONI FISCALI GIA' PRESE DALL'UTENTE ===
Per le seguenti righe, la decisione fiscale è già stata presa e confermata dall'utente:
${preLines.join("\n")}
NON generare alert per queste righe su questi tipi. Applica i valori fiscali già decisi.
===\n`;
    }

    // ─── Build rule-confirmed flags section ─────────────────
    let ruleConfirmedSection = "";
    const ruleConfirmedLineIds = new Set<string>();
    const ruleConfirmedLines = lines.filter(
      (l) => l.fiscal_flags_source === "rule_confirmed" && l.fiscal_flags_preset
    );
    if (ruleConfirmedLines.length > 0) {
      ruleConfirmedLineIds.add(...ruleConfirmedLines.map((l) => l.line_id));
      const rcLines = ruleConfirmedLines.map((l) => {
        const fp = l.fiscal_flags_preset as any;
        return `- [${l.line_id}] "${l.description.slice(0, 80)}" → deducib=${fp.deducibilita_pct ?? "?"}% IVA_detr=${fp.iva_detraibilita_pct ?? "?"}% (confermata da regola)`;
      });
      ruleConfirmedSection = `\n=== FISCALITA' CONFERMATA DA REGOLE ===
Per queste righe, la fiscalità è già stata confermata dall'utente tramite regola appresa:
${rcLines.join("\n")}
Verificale solo se noti un'incongruenza EVIDENTE. Non generare alert su queste.
===\n`;
    }

    // ─── Build classified lines section ──────────────────────
    const lineEntries = lines.map((l, i) => {
      const ff = l.fiscal_flags;
      return `${i + 1}. [${l.line_id}] "${l.description}" tot=${l.total_price ?? "N/D"}
   → conto: ${l.account_code || "N/D"} (${l.account_name || "N/D"}) | cat: ${l.category_name || "N/D"} | conf: ${l.confidence} | source: ${l.source}
   → fiscale: deducib=${ff.deducibilita_pct}% IVA_detr=${ff.iva_detraibilita_pct}% ritenuta=${ff.ritenuta_acconto ? ff.ritenuta_acconto.aliquota + "%" : "no"} RC=${ff.reverse_charge} SP=${ff.split_payment} BS=${ff.bene_strumentale}${ff.note ? ` nota:"${ff.note}"` : ""}`;
    }).join("\n\n");

    // ─── Build prompt with Admin Panel data ──────────────────
    const promptParts: string[] = [];

    // 1. System prompt from agent_config (or fallback)
    if (agentConfig?.system_prompt) {
      promptParts.push(agentConfig.system_prompt);
    } else {
      promptParts.push("Sei un REVISORE CONTABILE italiano senior. Devi controllare la classificazione fiscale di questa fattura.");
    }
    promptParts.push("");

    // 2. Agent rules (BEFORE everything else)
    const rulesBlock = formatAgentRules(agentRules);
    if (rulesBlock) {
      promptParts.push(rulesBlock);
      promptParts.push("");
    }

    // 3. Knowledge base rules (with fiscal_values for the reviewer)
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

    // 5. Counterparty + direction
    promptParts.push(`CONTROPARTE: ${counterpartyInfo}`);
    promptParts.push(`DIREZIONE: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}`);
    promptParts.push("");

    // 6. Pre-resolved decisions + rule-confirmed flags
    if (preResolvedSection) promptParts.push(preResolvedSection);
    if (ruleConfirmedSection) promptParts.push(ruleConfirmedSection);

    // 7. Classified lines
    promptParts.push(`RIGHE CLASSIFICATE (da commercialista):\n${lineEntries}`);
    promptParts.push("");

    // 8. Task instructions + output format
    promptParts.push(`IL TUO COMPITO:
1. Per ogni riga, VERIFICA i fiscal_flags. Correggi se necessario.
2. Genera ALERT per l'utente quando serve una decisione umana.
3. Per le righe con decisioni già prese dall'utente o confermate da regole, RISPETTA le scelte (salvo incongruenze evidenti).

REGOLE DI VERIFICA:
- Ritenuta d'acconto: SOLO su compensi a professionisti individuali (persone fisiche). MAI su SRL, SPA, cooperative. Controlla il tipo legale della controparte.
- Bene strumentale: SOLO beni FISICI DUREVOLI > 516,46€. MAI su: canoni leasing, servizi, materiali di consumo, manodopera, utenze, affitti, noleggi.
- IVA indetraibile: auto non da trasporto 40%, telefonia 50%, rappresentanza 0% se > 50€.
- Reverse charge: solo settore edile tra imprese (ATECO 41-43), o acquisti intracomunitari.
- Split payment: solo verso PA (controlla ragione sociale).
- Deducibilità: auto non da trasporto 20%, telefonia 80%, ristorazione 75%.
- Coerenza: tutte le righe per lo stesso tipo di operazione devono avere le STESSE percentuali.

FORMATO OUTPUT (2 sezioni):

Sezione 1 — JSON array revisioni:
[{"line_id":"uuid","fiscal_flags_corrected":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"issues":["descrizione problema"],"confidence_adjustment":0}]

---ALERTS---
JSON array di alert fiscali per l'utente (solo se servono decisioni umane):
[{"type":"deducibilita"|"ritenuta"|"reverse_charge"|"split_payment"|"bene_strumentale"|"iva_indetraibile"|"general","severity":"warning"|"info","title":"titolo breve","description":"spiegazione per l'utente","current_choice":"scelta conservativa applicata","options":[{"label":"Opzione A","fiscal_override":{},"is_default":false},{"label":"Opzione B","fiscal_override":{},"is_default":true}],"affected_lines":["line_id1"]}]
Se nessun alert: []`);

    const prompt = promptParts.join("\n");

    // ─── Call Gemini (using config model/temperature/thinking) ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.1;
    const thinkingLevel = agentConfig?.thinking_level || "high";
    const thinkingBudget: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = thinkingBudget[thinkingLevel] ?? 24576;

    console.log(`[fiscal-reviewer] Using model=${model} temp=${temperature} thinking=${thinkingLevel}(${budget})`);

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

    // Parse reviews
    const reviewStr = extractFirstJsonArray(responseText);
    let reviews: ReviewResult[] = [];
    if (reviewStr) {
      try { reviews = JSON.parse(reviewStr); } catch { /* ignore */ }
    }

    // Apply pre-resolved fiscal overrides to reviews
    for (const [lineId, decs] of preResolvedFiscal) {
      let review = reviews.find((r) => r.line_id === lineId);
      if (!review) {
        const line = lines.find((l) => l.line_id === lineId);
        if (line) {
          review = {
            line_id: lineId,
            fiscal_flags_corrected: { ...line.fiscal_flags },
            issues: [],
            confidence_adjustment: 5,
          };
          reviews.push(review);
        }
      }
      if (review) {
        for (const d of decs) {
          review.fiscal_flags_corrected = {
            ...review.fiscal_flags_corrected,
            ...d.fiscal_override,
          };
          if (!review.issues.some((i) => i.includes("decisione utente"))) {
            review.issues.push(`Decisione fiscale utente applicata (${d.chosen_option}, ${d.times_applied}x)`);
          }
          review.confidence_adjustment = Math.max(review.confidence_adjustment, 5);
        }
      }
    }

    // Parse alerts — filter out alerts for pre-resolved lines/types
    const alertStr = extractJsonSection(responseText, "---ALERTS---");
    let alerts: FiscalAlert[] = [];
    if (alertStr) {
      try {
        const rawAlerts: FiscalAlert[] = JSON.parse(alertStr);
        alerts = rawAlerts.filter((a) => {
          const remainingLines = a.affected_lines.filter((lid) => {
            const preTypes = preResolvedAlertTypes.get(lid);
            if (preTypes && preTypes.has(a.type)) return false;
            return true;
          });
          a.affected_lines = remainingLines;
          return remainingLines.length > 0;
        });
      } catch { /* ignore */ }
    }

    await sql.end();

    return json({
      reviews,
      alerts,
      pre_resolved_count: preResolvedFiscal.size,
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
        kb_source_table: "knowledge_base",
        company_ateco: companyAteco,
        company_sector: companyName,
        counterparty_ateco: counterpartyAteco,
        counterparty_legal_type: counterpartyLegalType,
        pre_resolved_decisions: [...preResolvedFiscal.entries()].map(([lid, decs]) => ({
          line_id: lid,
          decisions: decs.map(d => d.alert_type + ": " + d.chosen_option),
        })),
        rule_confirmed_lines: [...ruleConfirmedLineIds],
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
