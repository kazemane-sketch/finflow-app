// fiscal-reviewer — Fiscal Review Agent (Revisore)
// Reviews ALL classified lines (from both deterministic + AI) and produces:
// 1. Validated/corrected fiscal_flags per line
// 2. Invoice-level fiscal alerts (notes) for user decisions
//
// v3: Reads agent_config, agent_rules, knowledge_base from Admin Panel DB.
//     Uses thinking_level from config for thorough fiscal analysis.
//     Pre-applies fiscal_decisions (user choices on past alerts) from Fase 3.

import postgres from "npm:postgres@3.4.5";
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

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

/* ─── Types ──────────────────────────────── */

interface ClassifiedLine {
  line_id: string;
  description: string;
  total_price: number | null;
  vat_rate?: number | null;
  category_id?: string | null;
  category_name: string | null;
  account_id?: string | null;
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

interface SupportingEvidence {
  source: string;
  label: string;
  detail?: string | null;
  ref?: string | null;
}

interface ReviewerLineVerdict {
  line_id: string;
  decision_status: "finalized" | "needs_review" | "unassigned" | "pending";
  rationale_summary: string;
  decision_basis: string[];
  supporting_factors: string[];
  supporting_evidence: SupportingEvidence[];
  clear_fields?: string[];
  consultant_recommended?: boolean;
}

interface ReviewerResponse {
  invoice_summary_final?: string | null;
  line_verdicts?: ReviewerLineVerdict[];
  escalation_candidates?: string[];
  red_flags?: string[];
  reviews?: ReviewResult[];
  alerts?: FiscalAlert[];
}

/* ─── Admin Panel types ─────────────────── */

interface AgentConfig {
  agent_type: string;
  system_prompt: string;
  model: string;
  temperature: number;
  thinking_level: string;
  thinking_budget?: number | null;
  thinking_effort?: string | null;
  max_output_tokens: number;
}

const CONTABILE_LEAK_PATTERNS = [
  /\bconto\b/i,
  /\bcategoria\b/i,
  /\barticolo\b/i,
  /\bfase\b/i,
  /\bcdc\b/i,
  /\bcentro di costo\b/i,
  /\bnormalizz/i,
  /\briclassific/i,
  /\bnuovo conto\b/i,
  /\bnuova categoria\b/i,
  /\b[A-Z]\d{3,}\b/,
  /\b\d{4,}\b\s*[-–—]\s*[A-Za-zÀ-ÿ]/,
];

function looksLikeContabileLeak(text: string): boolean {
  return CONTABILE_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizeReviewerText(text: unknown, fallback: string): string {
  const raw = String(text || "").trim();
  if (!raw) return fallback;

  const kept = raw
    .split(/(?<=[.;!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => !looksLikeContabileLeak(chunk));

  const cleaned = kept.join(" ").trim();
  return cleaned || fallback;
}

function sanitizeReviewerList(values: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(values)) return fallback;
  const cleaned = values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => !looksLikeContabileLeak(value));

  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeReviewerEvidence(values: unknown): SupportingEvidence[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => value && typeof value === "object")
    .map((value) => {
      const row = value as Record<string, unknown>;
      const label = sanitizeReviewerText(row.label, "Evidenza fiscale");
      const detail = row.detail == null
        ? null
        : sanitizeReviewerText(row.detail, "");
      const ref = String(row.ref || "").trim() || null;
      const signature = [label, detail || "", ref || ""].join(" ");
      if (looksLikeContabileLeak(signature)) return null;
      return {
        source: String(row.source || "kb").trim() || "kb",
        label,
        detail: detail || null,
        ref,
      };
    })
    .filter((value): value is SupportingEvidence => Boolean(value));
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
  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const openaiKey = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

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
  const invoiceNotes = body.invoice_notes || null;
  const invoiceCausale = body.invoice_causale || null;

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
        SELECT agent_type, system_prompt, model, temperature, thinking_level, thinking_budget, thinking_effort, max_output_tokens
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
    const agentConfig = agentConfigs[0] || null;

    // Counterparty info
    let counterpartyInfo = counterpartyName;
    let counterpartyLegalType = "";
    let counterpartyAteco = "";
    let counterpartyBusinessSector = "";
    const cpRow = counterpartyRows[0];
    if (cpRow) {
      counterpartyLegalType = cpRow.legal_type || "";
      counterpartyAteco = cpRow.ateco_code || "";
      const parts = [`P.IVA: ${counterpartyVatKey}`];
      if (cpRow.ateco_code) parts.push(`ATECO: ${cpRow.ateco_code} ${cpRow.ateco_description || ""}`);
      if (cpRow.legal_type) parts.push(`Tipo: ${cpRow.legal_type}`);
      if (cpRow.business_sector) {
        parts.push(`Settore: ${cpRow.business_sector}`);
        counterpartyBusinessSector = cpRow.business_sector;
      }
      counterpartyInfo += ` — ${parts.join(" — ")}`;
    }
    console.log(`[fiscal-reviewer] Admin Panel: config=${agentConfig ? "✓" : "✗"} rules=${agentRules.length}`);

    let kbNotesSection = "";
    let kbChunksSection = "";
    let kbNoteTitles: string[] = [];
    let kbChunkDebug: { title: string; similarity: number }[] = [];
    let queryVecLiteral = "";
    if (shouldConsultKbAdvisory({
      mode: "revisore",
      lineDescriptions,
      exactMatchCount: lines.filter((line) => /rule|history|exact/i.test(String(line.source || ""))).length,
      totalLines: lines.length,
      confidences: lines.map((line) => Number(line.confidence || 0)),
      fiscalNotes: lines.map((line) => String(line.fiscal_flags?.note || "")),
    })) {
      try {
        const ragQueryText = lines.map((line) => line.description).join(" | ") + ` | ${counterpartyName}`;
        const ragVec = await callGeminiEmbedding(geminiKey, ragQueryText);
        queryVecLiteral = toVectorLiteral(ragVec);
        const advisoryContext = await loadKbAdvisoryContext(sql, {
          companyId,
          audience: "revisore",
          queryVecLiteral,
          queryText: ragQueryText,
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
        console.log(`[fiscal-reviewer] KB advisory notes=${advisoryContext.notes.length} chunks=${advisoryContext.chunks.length}`);
      } catch (e) {
        console.warn("[fiscal-reviewer] KB advisory retrieval failed:", e);
      }
    }

    // ─── Pre-resolve fiscal decisions (Fase 3 — preserved) ──────────
    const preResolvedFiscal = new Map<string, {
      alert_type: string;
      fiscal_override: Record<string, unknown>;
      chosen_option: string;
      times_applied: number;
    }[]>();
    const staleSourceDecisionsIgnored: {
      id: string;
      source_invoice_id: string;
      classification_status: string;
      chosen_option: string;
    }[] = [];

    if (vatKey) {
      const fiscalDecisions = await sql`
        SELECT id, operation_group_code, subject_keywords, alert_type,
               chosen_option_label, fiscal_override, times_applied,
               contract_ref, account_id, source_invoice_id
        FROM fiscal_decisions
        WHERE company_id = ${companyId}
          AND counterparty_vat_key = ${vatKey}
          AND direction = ${direction}`;

      if (fiscalDecisions.length > 0) {
        const sourceInvoiceIds = fiscalDecisions
          .map((dec) => dec.source_invoice_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        const sourceInvoiceStatuses = new Map<string, string>();
        if (sourceInvoiceIds.length > 0) {
          const sourceInvoices = await sql`
            SELECT id, classification_status
            FROM invoices
            WHERE id = ANY(${sourceInvoiceIds}::uuid[])`;
          for (const row of sourceInvoices) {
            sourceInvoiceStatuses.set(row.id, row.classification_status || "");
          }
        }

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
            const sourceInvoiceId = dec.source_invoice_id as string | null;
            const sourceInvoiceStatus = sourceInvoiceId ? sourceInvoiceStatuses.get(sourceInvoiceId) : null;
            if (sourceInvoiceId && sourceInvoiceStatus === "none") {
              staleSourceDecisionsIgnored.push({
                id: dec.id,
                source_invoice_id: sourceInvoiceId,
                classification_status: sourceInvoiceStatus,
                chosen_option: dec.chosen_option_label,
              });
              continue;
            }

            if (dec.operation_group_code !== lineGroupCode) continue;

            // Strong-reference compatibility: specific learned decisions
            // can only flow to invoices carrying the same normalized reference.
            if (dec.contract_ref) {
              if (!contractRefs.includes(dec.contract_ref)) continue;
            }

            // Account ID compatibility: if the decision has an account_id,
            // the line must have the same account
            if (dec.account_id) {
              if (line.account_id !== dec.account_id) continue;
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
   → IVA fattura: ${l.vat_rate != null ? `${l.vat_rate}%` : "N/D"}
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

    // 3. KB consultiva mirata
    if (kbNotesSection) {
      promptParts.push(kbNotesSection);
      promptParts.push("");
    }
    if (kbChunksSection) {
      promptParts.push(kbChunksSection);
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

    // 5b. Invoice notes + causale context
    if (invoiceNotes || invoiceCausale) {
      promptParts.push("=== INFORMAZIONI AGGIUNTIVE FATTURA ===");
      if (invoiceCausale) promptParts.push(`Causale fattura (dall'XML): ${invoiceCausale}`);
      if (invoiceNotes) promptParts.push(`Note utente: ${invoiceNotes}`);
      promptParts.push("Usa queste informazioni per capire meglio la natura dell'operazione.");
      promptParts.push("===");
      promptParts.push("");
    }

    // 6. Pre-resolved decisions + rule-confirmed flags
    if (preResolvedSection) promptParts.push(preResolvedSection);
    if (ruleConfirmedSection) promptParts.push(ruleConfirmedSection);

    // 7. Classified lines
    promptParts.push(`RIGHE CLASSIFICATE (da commercialista):\n${lineEntries}`);
    promptParts.push("");

    // 8. Task instructions + output format
    promptParts.push(`IL TUO COMPITO:
1. Per ogni riga, VERIFICA i fiscal_flags. Correggi se necessario.
2. Produci il VERDETTO FINALE operativo per la riga: finalized, needs_review oppure unassigned.
3. Genera ALERT per l'utente quando serve una decisione umana.
4. Per le righe con decisioni già prese dall'utente o confermate da regole, RISPETTA le scelte (salvo incongruenze evidenti).

REGOLE DI VERIFICA:
- Ambito del revisore: il revisore fiscale NON propone nuovi conti, categorie, articoli, fasi o CdC. Se la classificazione contabile appare debole, segnala il dubbio ma non inventare codici o descrizioni alternative e non usare clear_fields per cancellare campi contabili.
- Ritenuta d'acconto: SOLO su compensi a professionisti individuali (persone fisiche). MAI su SRL, SPA, cooperative. Controlla il tipo legale della controparte.
- Bene strumentale: SOLO beni FISICI DUREVOLI > 516,46€. MAI su: canoni leasing, servizi, materiali di consumo, manodopera, utenze, affitti, noleggi.
- IVA indetraibile: auto non da trasporto 40%, telefonia 50%, rappresentanza 0% se > 50€.
- Reverse charge: solo settore edile tra imprese (ATECO 41-43), o acquisti intracomunitari.
- Split payment: solo verso PA (controlla ragione sociale).
- Deducibilità: auto non da trasporto 20%, telefonia 80%, ristorazione 75%.
- Coerenza: tutte le righe per lo stesso tipo di operazione devono avere le STESSE percentuali.
- Se il commercialista non ha abbastanza evidenza, NON completare la riga a forza: usa needs_review o unassigned.

FORMATO OUTPUT:
Rispondi con un SOLO JSON object:
{
  "invoice_summary_final":"sintesi finale della fattura",
  "red_flags":["rischio 1","rischio 2"],
  "escalation_candidates":["line_id1"],
  "line_verdicts":[
    {
      "line_id":"uuid",
      "decision_status":"finalized"|"needs_review"|"unassigned",
      "rationale_summary":"spiega la scelta finale o il perche non decidi",
      "decision_basis":["fattura intera","revisione fiscale","memoria aziendale"],
      "supporting_factors":["fattore 1","fattore 2"],
      "supporting_evidence":[{"source":"kb","label":"Titolo","detail":"breve dettaglio"}],
      "clear_fields":[],
      "consultant_recommended":false
    }
  ],
  "reviews":[
    {"line_id":"uuid","fiscal_flags_corrected":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"issues":["descrizione problema"],"confidence_adjustment":0}
  ],
  "alerts":[
    {"type":"deducibilita"|"ritenuta"|"reverse_charge"|"split_payment"|"bene_strumentale"|"iva_indetraibile"|"general","severity":"warning"|"info","title":"titolo breve","description":"spiegazione per l'utente","current_choice":"scelta conservativa applicata","options":[{"label":"Opzione A","fiscal_override":{},"is_default":false},{"label":"Opzione B","fiscal_override":{},"is_default":true}],"affected_lines":["line_id1"]}
  ]
}
Se non servono alert: "alerts": []`);

    const prompt = promptParts.join("\n");

    // ─── Call Gemini (using config model/temperature/thinking) ────
    const model = agentConfig?.model || "gemini-2.5-flash";
    const temperature = agentConfig?.temperature ?? 0.1;
    const thinkingLevel = agentConfig?.thinking_level || "high";
    const thinkingBudget: Record<string, number> = {
      none: 0, low: 1024, medium: 8192, high: 24576,
    };
    const budget = agentConfig?.thinking_budget ?? thinkingBudget[thinkingLevel] ?? 24576;
    const maxOutputTokens = agentConfig?.max_output_tokens || 32768;

    console.log(`[fiscal-reviewer] Using model=${model} temp=${temperature} thinking=${thinkingLevel}(${budget})`);

    let responseText = "";
    let thinkingText = "";
    
    try {
      const llmResp = await callLLM(prompt, {
        model,
        temperature,
        thinkingBudget: budget,
        maxOutputTokens,
        systemPrompt: "",
      }, { geminiKey, anthropicKey, openaiKey });
      
      responseText = llmResp.text;
      thinkingText = llmResp.thinking || "";
    } catch (e: any) {
      await sql.end();
      return json({ error: `LLM API Error: ${e.message}` }, 502);
    }

    let structuredResponse: ReviewerResponse = {};
    try {
      const parsed = extractJson(responseText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        structuredResponse = parsed as ReviewerResponse;
      }
    } catch {
      // keep legacy fallback below
    }

    // Parse reviews — prefer structured object, keep legacy fallback
    let reviews: ReviewResult[] = Array.isArray(structuredResponse.reviews)
      ? structuredResponse.reviews
      : [];
    if (reviews.length === 0) {
      const reviewStr = extractFirstJsonArray(responseText);
      if (reviewStr) {
        try { reviews = JSON.parse(reviewStr); } catch { /* ignore */ }
      }
    }
    if (reviews.length === 0) {
      try {
        const fallback = extractJson(responseText);
        reviews = Array.isArray(fallback) ? fallback : [fallback];
        console.warn(`[fiscal-reviewer] extractFirstJsonArray failed, extractJson fallback OK: ${reviews.length} items`);
      } catch { /* both failed */ }
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

    reviews = reviews
      .filter((review) => review && typeof review === "object" && String(review.line_id || "").trim())
      .map((review) => ({
        line_id: String(review.line_id || "").trim(),
        fiscal_flags_corrected: review.fiscal_flags_corrected,
        issues: sanitizeReviewerList(review.issues, []),
        confidence_adjustment: Math.max(
          -20,
          Math.min(20, Number.isFinite(Number(review.confidence_adjustment)) ? Number(review.confidence_adjustment) : 0),
        ),
      }));

    let lineVerdicts: ReviewerLineVerdict[] = Array.isArray(structuredResponse.line_verdicts)
      ? structuredResponse.line_verdicts
      : [];

    // Parse alerts — prefer structured object, filter out pre-resolved lines/types
    let alerts: FiscalAlert[] = [];
    if (Array.isArray(structuredResponse.alerts)) {
      alerts = structuredResponse.alerts;
    } else {
      const alertStr = extractJsonSection(responseText, "---ALERTS---");
      if (alertStr) {
        try {
          alerts = JSON.parse(alertStr);
        } catch { /* ignore */ }
      }
    }

    alerts = alerts.filter((a) => {
      const remainingLines = a.affected_lines.filter((lid) => {
        const preTypes = preResolvedAlertTypes.get(lid);
        if (preTypes && preTypes.has(a.type)) return false;
        return true;
      });
      a.affected_lines = remainingLines;
      return remainingLines.length > 0;
    });

    const invoiceSummaryFinal = sanitizeReviewerText(
      structuredResponse.invoice_summary_final,
      "Revisione fiscale completata sulla fattura.",
    );
    const redFlags = sanitizeReviewerList(structuredResponse.red_flags, []);
    const escalationCandidates = Array.isArray(structuredResponse.escalation_candidates)
      ? Array.from(new Set(structuredResponse.escalation_candidates.map((lineId) => String(lineId || "").trim()).filter(Boolean)))
      : [];

    if (lineVerdicts.length > 0) {
      lineVerdicts = lineVerdicts
        .filter((verdict) => verdict && typeof verdict === "object" && String(verdict.line_id || "").trim())
        .map((verdict) => ({
          line_id: String(verdict.line_id || "").trim(),
          decision_status: verdict.decision_status === "finalized" || verdict.decision_status === "unassigned"
            ? verdict.decision_status
            : "needs_review",
          rationale_summary: sanitizeReviewerText(
            verdict.rationale_summary,
            "Il revisore fiscale mantiene un dubbio operativo da verificare.",
          ),
          decision_basis: sanitizeReviewerList(verdict.decision_basis, ["revisione fiscale"]),
          supporting_factors: sanitizeReviewerList(
            verdict.supporting_factors,
            ["Valutazione fiscale condotta sul contesto disponibile"],
          ),
          supporting_evidence: sanitizeReviewerEvidence(verdict.supporting_evidence),
          clear_fields: [],
          consultant_recommended: Boolean(verdict.consultant_recommended),
        }));
    }

    if (lineVerdicts.length === 0) {
      lineVerdicts = lines.map((line) => {
        const review = reviews.find((item) => item.line_id === line.line_id);
        const issues = review?.issues || [];
        const issueText = issues.join("; ");
        const adjustedConfidence = Math.max(0, Math.min(100, Number(line.confidence || 0) + Number(review?.confidence_adjustment || 0)));
        const hasMaterialDoubt = /dubbio|verific|incert|chiar/i.test(issueText);
        const decisionStatus = !line.account_id && !line.category_name
          ? "unassigned"
          : hasMaterialDoubt || adjustedConfidence < 60
            ? "needs_review"
            : "finalized";
        return {
          line_id: line.line_id,
          decision_status: decisionStatus,
          rationale_summary: sanitizeReviewerText(
            issues.length > 0 ? issueText : "",
            "Verdetto fiscale finale confermato dal revisore",
          ),
          decision_basis: ["revisione fiscale"],
          supporting_factors: issues.length > 0 ? issues : ["Nessuna anomalia fiscale materiale rilevata"],
          supporting_evidence: [],
          clear_fields: [],
          consultant_recommended: decisionStatus === "needs_review" && adjustedConfidence < 55,
        };
      });
    }

    await sql.end();

    return json({
      reviews,
      reviewer_verdict: {
        invoice_summary_final: invoiceSummaryFinal || null,
        line_verdicts: lineVerdicts,
        escalation_candidates: escalationCandidates,
        red_flags: redFlags,
      },
      alerts,
      thinking: thinkingText || null,
      pre_resolved_count: preResolvedFiscal.size,
      prompt_length: prompt.length,
      model_used: model,
      kb_notes_used: kbNoteTitles.length,
      agent_rules_used: agentRules.length,
      _debug: {
        prompt_sent: prompt,
        raw_response: responseText,
        model_used: model,
        agent_config_loaded: !!agentConfig,
        agent_rules_count: agentRules.length,
        kb_notes_used: kbNoteTitles.length,
        kb_note_titles: kbNoteTitles,
        company_ateco: companyAteco,
        company_sector: companyName,
        counterparty_ateco: counterpartyAteco,
        counterparty_legal_type: counterpartyLegalType,
        pre_resolved_decisions: [...preResolvedFiscal.entries()].map(([lid, decs]) => ({
          line_id: lid,
          decisions: decs.map(d => d.alert_type + ": " + d.chosen_option),
        })),
        stale_source_decisions_ignored: staleSourceDecisionsIgnored,
        rule_confirmed_lines: [...ruleConfirmedLineIds],
        kb_chunks_used: kbChunkDebug.length,
        kb_chunks: kbChunkDebug,
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
