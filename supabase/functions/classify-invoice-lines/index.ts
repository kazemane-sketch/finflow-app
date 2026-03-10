// classify-invoice-lines — Unified Sonnet classifier for invoice lines
// Replaces both classification-ai-suggest and article-ai-match with a single
// Sonnet call that has full context: articles, categories, CoA, CdC, ATECO,
// counterparty history, RAG examples.
//
// PRINCIPLE: produces SUGGESTIONS only (classification_status = 'ai_suggested'
// on invoices table). NEVER 'confirmed'. User must always confirm.

import postgres from "npm:postgres@3.4.5";
import {
  getAccountingSystemPrompt,
  getCompanyMemoryBlock,
  getUserInstructionsBlock,
  type CompanyContext,
  type MemoryFact,
} from "../_shared/accounting-system-prompt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─── Model constants ────────────────────── */
const MODEL_HAIKU = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-6";
const ESCALATION_THRESHOLD = 70;  // Lines below this confidence get escalated to Sonnet
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const MIN_CONFIDENCE = 60;

// Backward compat: keep MODEL for stats reporting
const MODEL = MODEL_HAIKU;

/* ─── Direction enforcement constants ────── */
// Which CoA sections are valid for each invoice direction
const SECTIONS_FOR_DIRECTION: Record<string, { primary: string[]; allowed: string[] }> = {
  in: {
    // Passive (purchase) → cost accounts primarily
    primary: ["cost_production", "cost_personnel", "depreciation", "other_costs"],
    // Also allowed: financial (64xxx interest), assets (21xxx immobilizzazioni), extraordinary
    allowed: ["cost_production", "cost_personnel", "depreciation", "other_costs", "financial", "extraordinary", "assets", "liabilities"],
  },
  out: {
    // Active (sale) → revenue accounts primarily
    primary: ["revenue"],
    // Also allowed: financial (72xxx proventi), extraordinary
    allowed: ["revenue", "financial", "extraordinary"],
  },
};
// Which category types are valid for each direction
const CAT_TYPES_FOR_DIRECTION: Record<string, string[]> = {
  in: ["expense", "both"],
  out: ["revenue", "both"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── Types ─────────────────────────────── */

interface InputLine {
  line_id: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
}

interface ArticleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  keywords: string[];
}
interface CategoryRow {
  id: string;
  name: string;
  type: string;
}
interface AccountRow {
  id: string;
  code: string;
  name: string;
  section: string;
}
interface ProjectRow {
  id: string;
  code: string;
  name: string;
}
interface ArticlePhaseRow {
  id: string;
  article_id: string;
  code: string;
  name: string;
  phase_type: string;
  is_counting_point: boolean;
  invoice_direction: string | null;
}

interface HistoryRow {
  description: string;
  category_name: string | null;
  account_code: string | null;
  account_name: string | null;
  article_code: string | null;
  article_name: string | null;
  phase_code: string | null;
  phase_name: string | null;
  cost_center_allocations: unknown;
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

interface SonnetLineResult {
  line_id: string;
  article_code: string | null;
  phase_code: string | null;
  category_id: string | null;
  category_name: string | null;    // fallback when AI garbles UUID
  account_id: string | null;
  account_code: string | null;     // fallback when AI garbles UUID
  cost_center_allocations: { project_id: string; percentage: number }[] | null;
  confidence: number;
  reasoning: string;
  fiscal_flags?: FiscalFlags | null;
  suggest_new_account?: {
    code: string;
    name: string;
    section: string;
    parent_code: string;
    reason: string;
  } | null;
  suggest_new_category?: {
    name: string;
    type: string;
    reason: string;
  } | null;
}

/* ─── Gemini embedding (for RAG) ────────── */

function toVectorLiteral(values: number[]): string {
  return `[${values
    .map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0"))
    .join(",")}]`;
}

async function callGeminiEmbedding(
  apiKey: string,
  text: string,
): Promise<number[]> {
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
  if (!response.ok)
    throw new Error(
      `Gemini error: ${payload?.error?.message || response.status}`,
    );
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS)
    throw new Error("Bad embedding dims");
  return values.map((v: unknown) => Number(v));
}

/* ─── Load RAG examples ─────────────────── */

interface RagExample {
  output_label: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

async function loadRagExamples(
  sql: SqlClient,
  companyId: string,
  queryText: string,
  geminiKey: string,
): Promise<RagExample[]> {
  try {
    const vec = await callGeminiEmbedding(geminiKey, queryText);
    const vecLiteral = toVectorLiteral(vec);
    const matches = await sql.unsafe(
      `SELECT output_label, metadata,
              (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
       FROM learning_examples
       WHERE company_id = $2
         AND domain IN ('classification', 'article_assignment')
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::halfvec(3072)
       LIMIT 10`,
      [vecLiteral, companyId],
    );
    return (matches as RagExample[]).filter((m) => m.similarity >= 0.65);
  } catch (err) {
    console.warn("[classify-invoice-lines] RAG error:", err);
    return [];
  }
}

/* ─── Embedding pre-flight: find relevant entities ── */

interface PreflightResult {
  accounts: AccountRow[];
  categories: CategoryRow[];
  articles: (ArticleRow & { similarity: number })[];
  projects: ProjectRow[];
  memoryFacts: MemoryFact[];
  queryVec: number[];
}

async function embeddingPreflight(
  sql: SqlClient,
  companyId: string,
  lines: InputLine[],
  counterpartyName: string,
  counterpartyId: string | null,
  direction: string,
  geminiKey: string,
  dirSections: { primary: string[]; allowed: string[] },
  allowedCatTypes: string[],
): Promise<PreflightResult | null> {
  try {
    // Build query text from all line descriptions + counterparty
    const queryText =
      lines.map((l) => l.description).filter(Boolean).join(" | ") +
      ` | ${counterpartyName || "N/D"}`;

    // 1. Compute single Gemini embedding
    const queryVec = await callGeminiEmbedding(geminiKey, queryText);
    const vecLiteral = toVectorLiteral(queryVec);

    // 2. Run 5 parallel pgvector queries
    const [pfAccounts, pfCategories, pfArticles, pfProjects, pfMemory] =
      await Promise.all([
        sql.unsafe(
          `SELECT id, code, name, section, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
           FROM chart_of_accounts
           WHERE company_id = $2 AND active = true AND is_header = false AND embedding IS NOT NULL
             AND section = ANY($3::text[])
           ORDER BY embedding <=> $1::halfvec(3072) LIMIT 20`,
          [vecLiteral, companyId, dirSections.allowed],
        ),
        sql.unsafe(
          `SELECT id, name, type, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
           FROM categories
           WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
             AND type = ANY($3::text[])
           ORDER BY embedding <=> $1::halfvec(3072) LIMIT 10`,
          [vecLiteral, companyId, allowedCatTypes],
        ),
        sql.unsafe(
          `SELECT id, code, name, keywords, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
           FROM articles
           WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::halfvec(3072) LIMIT 10`,
          [vecLiteral, companyId],
        ),
        sql.unsafe(
          `SELECT id, code, name, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
           FROM projects
           WHERE company_id = $2 AND status = 'active' AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::halfvec(3072) LIMIT 8`,
          [vecLiteral, companyId],
        ),
        counterpartyId
          ? sql.unsafe(
              `SELECT id, fact_type, fact_text, metadata, counterparty_id,
                      (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
               FROM company_memory
               WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
                 AND (counterparty_id IS NULL OR counterparty_id = $3)
               ORDER BY embedding <=> $1::halfvec(3072) LIMIT 15`,
              [vecLiteral, companyId, counterpartyId],
            )
          : sql.unsafe(
              `SELECT id, fact_type, fact_text, metadata, counterparty_id,
                      (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
               FROM company_memory
               WHERE company_id = $2 AND active = true AND embedding IS NOT NULL
               ORDER BY embedding <=> $1::halfvec(3072) LIMIT 15`,
              [vecLiteral, companyId],
            ),
      ]);

    // Filter by similarity thresholds
    const accounts = (pfAccounts as (AccountRow & { similarity: number })[])
      .filter((a) => a.similarity >= 0.35);
    const categories = (pfCategories as (CategoryRow & { similarity: number })[])
      .filter((c) => c.similarity >= 0.35);
    const articles = (pfArticles as (ArticleRow & { similarity: number })[])
      .filter((a) => a.similarity >= 0.40);
    const projects = (pfProjects as (ProjectRow & { similarity: number })[]);
    const memoryFacts = (pfMemory as (MemoryFact & { similarity: number; id: string })[])
      .filter((m) => m.similarity >= 0.40)
      .map((m) => ({ fact_text: m.fact_text, fact_type: m.fact_type, similarity: m.similarity }));

    console.log(`[classify-preflight] accounts=${accounts.length}, cats=${categories.length}, arts=${articles.length}, projects=${projects.length}, memory=${memoryFacts.length}`);

    return { accounts, categories, articles, projects, memoryFacts, queryVec };
  } catch (err) {
    console.warn("[classify-preflight] Embedding pre-flight failed, will use full lists:", err);
    return null;
  }
}

/* ─── Build focused prompt for Haiku ─────── */

function buildFocusedPrompt(
  articles: ArticleRow[],
  categories: CategoryRow[],
  accounts: AccountRow[],
  projects: ProjectRow[],
  phases: ArticlePhaseRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  memoryBlock: string,
  direction: string,
  lines: InputLine[],
  systemPrompt: string,
  userInstructionsBlock: string,
): string {
  // Build phases-by-article map
  const phasesByArticle = new Map<string, ArticlePhaseRow[]>();
  for (const p of phases) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
    phasesByArticle.get(p.article_id)!.push(p);
  }

  // Articles section — only relevant articles from pre-flight
  const articleIds = new Set(articles.map(a => a.id));
  const relevantPhases = phases.filter(p => articleIds.has(p.article_id));
  const multiStep = articles.filter(a => phasesByArticle.has(a.id) && phasesByArticle.get(a.id)!.length > 0);
  const singleStep = articles.filter(a => !phasesByArticle.has(a.id) || phasesByArticle.get(a.id)!.length === 0);

  let artSection = "";
  if (multiStep.length > 0) {
    artSection += `ARTICOLI CON FASI:\n`;
    artSection += multiStep.map(a => {
      const aPhases = phasesByArticle.get(a.id)!;
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      let line = `- ${a.code} (${a.name})${kwPart}:\n`;
      line += aPhases.map(p =>
        `  ${p.code}: ${p.name}${p.is_counting_point ? " (COUNTING)" : ""}`
      ).join("\n");
      return line;
    }).join("\n");
  }
  if (singleStep.length > 0) {
    if (artSection) artSection += "\n";
    artSection += `ARTICOLI SENZA FASI:\n`;
    artSection += singleStep.map(a => {
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      return `- ${a.code} (${a.name})${kwPart}`;
    }).join("\n");
  }

  // Categories (compact)
  const catSection = categories.map(c => `- ${c.id}: ${c.name} (${c.type})`).join("\n");

  // Accounts (compact)
  const accSection = accounts.map(a => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n");

  // Projects (compact)
  const cdcSection = projects.length > 0
    ? projects.map(p => `- ${p.id}: ${p.code} ${p.name}`).join("\n")
    : "Nessun CdC.";

  // History (limited to 15 for focused prompt)
  const historyLimited = history.slice(0, 15);
  let historySection = "";
  if (historyLimited.length > 0) {
    const histLines = historyLimited.map(h => {
      const parts: string[] = [`"${h.description}"`];
      if (h.article_code) parts.push(`art:${h.article_code}`);
      if (h.category_name) parts.push(`cat:${h.category_name}`);
      if (h.account_code) parts.push(`conto:${h.account_code}`);
      return parts.join(" → ");
    });
    historySection = `STORICO (usa SOLO se la descrizione corrisponde):\n${histLines.join("\n")}`;
  }

  // Lines
  const lineEntries = lines
    .map((l, i) => `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}`)
    .join("\n");

  return `${systemPrompt}
${userInstructionsBlock}
${memoryBlock}

${artSection ? `ARTICOLI:\n${artSection}\n` : ""}CATEGORIE:
${catSection}

CONTI:
${accSection}

CDC:
${cdcSection}

=== CONTROPARTE FORNITORE/CLIENTE ===
${counterpartyInfo}
REGOLA: Il NOME della controparte spesso rivela la sua attività principale (es. "FRANTOI MERIDIONALI" = frantumazione inerti, "AUTOTRASPORTI ROSSI" = trasporto). Usa il nome come indizio forte per guidare la classificazione quando la descrizione riga è generica.
===

${historySection}

=== VINCOLO DIREZIONE (${direction === "in" ? "PASSIVA" : "ATTIVA"}) ===
${direction === "in" ? "Conti di COSTO. category.type: expense/both. VIETATO: conti revenue." : "Conti di RICAVO. category.type: revenue/both. VIETATO: conti costo."}
===

REGOLE:
- Usa storico SOLO se la descrizione corrisponde.
- article_code + phase_code solo se il materiale/prodotto corrisponde.
- category_id e account_id: assegna SEMPRE (UUID esatti dalla lista sopra).
- Coerenza: trasporto→conti trasporto, noleggio→conti noleggio.
- confidence 0-100. Se dubbio, confidence bassa.
- Righe con importo zero (tot=0): sono righe INFORMATIVE/CONTESTO (cantiere, contratto, commessa). Usale per classificare meglio le altre righe. Per la riga zero stessa: confidence 30-50, reasoning "Riga informativa/contesto".
- Se NESSUNA categoria nella lista corrisponde bene alla riga, NON forzare una categoria sbagliata con confidence alta. Scegli la più vicina MA con confidence <70 per attivare l'escalation.
- Il NOME della controparte rivela spesso l'attività: usalo come indizio forte.

RIGHE:
${lineEntries}

JSON array (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"confidence":0-100,"reasoning":"max 30 parole","fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]
---KEYWORDS---
["kw1","kw2",...] (5-10 keywords)`;
}

/* ─── Sonnet escalation with Extended Thinking ── */

async function callSonnetEscalation(
  apiKey: string,
  lowConfLines: SonnetLineResult[],
  haikuAttempt: SonnetLineResult[],
  inputLines: InputLine[],
  allAccounts: AccountRow[],
  allCategories: CategoryRow[],
  allArticles: ArticleRow[],
  phases: ArticlePhaseRow[],
  projects: ProjectRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  memoryBlock: string,
  direction: string,
  systemPrompt: string,
  userInstructionsBlock: string,
): Promise<SonnetLineResult[]> {
  // Only send the low-confidence lines
  const lowLineIds = new Set(lowConfLines.map(l => l.line_id));
  const lowInputLines = inputLines.filter(l => lowLineIds.has(l.line_id));

  // Build phases-by-article map for article section
  const phasesByArticle = new Map<string, ArticlePhaseRow[]>();
  for (const p of phases) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
    phasesByArticle.get(p.article_id)!.push(p);
  }

  // Full article section
  let artSection = allArticles.map(a => {
    const aPhases = phasesByArticle.get(a.id) || [];
    const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
    if (aPhases.length > 0) {
      return `- ${a.code} (${a.name})${kwPart}:\n${aPhases.map(p => `  ${p.code}: ${p.name}`).join("\n")}`;
    }
    return `- ${a.code} (${a.name})${kwPart}`;
  }).join("\n");

  // Full accounts + categories
  const catSection = allCategories.map(c => `- ${c.id}: ${c.name} (${c.type})`).join("\n");
  const accSection = allAccounts.map(a => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n");
  const cdcSection = projects.map(p => `- ${p.id}: ${p.code} ${p.name}`).join("\n") || "Nessun CdC.";

  // History section
  let historySection = "";
  if (history.length > 0) {
    const histLines = history.map(h => {
      const parts: string[] = [`"${h.description}"`];
      if (h.article_code) parts.push(`art:${h.article_code}`);
      if (h.category_name) parts.push(`cat:${h.category_name}`);
      if (h.account_code) parts.push(`conto:${h.account_code}`);
      return parts.join(" → ");
    });
    historySection = `STORICO:\n${histLines.join("\n")}`;
  }

  // Haiku attempt section — show what Haiku tried
  const haikuSection = lowConfLines.map(lr => {
    return `- Riga ${lr.line_id}: Haiku ha tentato category="${lr.category_name}" account="${lr.account_code}" confidence=${lr.confidence} reasoning="${lr.reasoning}"`;
  }).join("\n");

  // Lines to re-classify
  const lineEntries = lowInputLines.map((l, i) =>
    `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} prezzo_unit=${l.unit_price ?? "N/D"} totale=${l.total_price ?? "N/D"}`
  ).join("\n");

  // Extended Thinking requires system prompt in user message
  const fullPrompt = `${systemPrompt}
${userInstructionsBlock}
${memoryBlock}

Sei stato chiamato come ESCALATION per righe che il classificatore iniziale (Haiku) non è riuscito a classificare con sicurezza.
Analizza attentamente usando il CONTESTO COMPLETO sotto.

TENTATIVO PRECEDENTE (Haiku — bassa confidenza):
${haikuSection}

ARTICOLI COMPLETI:
${artSection}

CATEGORIE COMPLETE:
${catSection}

PIANO DEI CONTI COMPLETO:
${accSection}

CDC COMPLETI:
${cdcSection}

=== CONTROPARTE FORNITORE/CLIENTE ===
${counterpartyInfo}
REGOLA: Il NOME della controparte spesso rivela la sua attività principale. Usa il nome come indizio forte per guidare la classificazione quando la descrizione riga è generica.
===

${historySection}

=== VINCOLO DIREZIONE (${direction === "in" ? "PASSIVA" : "ATTIVA"}) ===
${direction === "in" ? "Conti di COSTO. category.type: expense/both. VIETATO: conti revenue." : "Conti di RICAVO. category.type: revenue/both. VIETATO: conti costo."}
===

RIGHE DA RI-CLASSIFICARE:
${lineEntries}

JSON array (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"confidence":0-100,"reasoning":"spiegazione breve","fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]`;

  console.log(`[classify-escalation] Calling Sonnet with Extended Thinking for ${lowConfLines.length} lines`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_SONNET,
      max_tokens: 16000,
      thinking: {
        type: "enabled",
        budget_tokens: 10000,
      },
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("[classify-escalation] Sonnet API error:", response.status, errText.slice(0, 300));
    // Return Haiku results as fallback (don't fail the whole pipeline)
    return lowConfLines;
  }

  const data = await response.json();
  // Extended Thinking returns thinking blocks + text blocks
  const textBlocks = ((data as any)?.content || []).filter((b: any) => b.type === "text");
  const text = textBlocks.map((b: any) => b.text).join("") || "";
  console.log(`[classify-escalation] Sonnet response: ${text.length} chars`);

  // Parse JSON from response
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[classify-escalation] No JSON array in Sonnet response");
      return lowConfLines;
    }
    const parsed: SonnetLineResult[] = JSON.parse(jsonMatch[0]);
    return parsed.map(item => ({
      line_id: item.line_id,
      article_code: item.article_code || null,
      phase_code: item.phase_code || null,
      category_id: item.category_id || null,
      category_name: item.category_name || null,
      account_id: item.account_id || null,
      account_code: item.account_code || null,
      cost_center_allocations: item.cost_center_allocations || [],
      confidence: Math.min(Math.max(Number(item.confidence) || 50, 0), 100),
      reasoning: `[SONNET] ${item.reasoning || ""}`,
      fiscal_flags: item.fiscal_flags || null,
      suggest_new_account: item.suggest_new_account || null,
      suggest_new_category: item.suggest_new_category || null,
    }));
  } catch (e) {
    console.error("[classify-escalation] Parse error:", e);
    return lowConfLines;
  }
}

/* ─── Build full prompt (legacy, for Sonnet escalation fallback) ── */

function buildPrompt(
  articles: ArticleRow[],
  categories: CategoryRow[],
  primaryAccounts: AccountRow[],
  secondaryAccounts: AccountRow[],
  projects: ProjectRow[],
  phases: ArticlePhaseRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  ragExamples: RagExample[],
  direction: string,
  lines: InputLine[],
  systemPrompt: string,
  userInstructionsBlock: string,
): string {
  // Build phases-by-article map
  const phasesByArticle = new Map<string, ArticlePhaseRow[]>();
  for (const p of phases) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
    phasesByArticle.get(p.article_id)!.push(p);
  }

  // Articles section — split multi-step (with phases) vs single-step (no phases)
  const multiStep = articles.filter(a => phasesByArticle.has(a.id) && phasesByArticle.get(a.id)!.length > 0);
  const singleStep = articles.filter(a => !phasesByArticle.has(a.id) || phasesByArticle.get(a.id)!.length === 0);

  let artSection = "";
  if (multiStep.length > 0) {
    artSection += `ARTICOLI CON FASI — assegna article_code + phase_code:\n`;
    artSection += multiStep.slice(0, 50).map(a => {
      const phases = phasesByArticle.get(a.id)!;
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      let line = `- ${a.code} (${a.name})${kwPart}:\n`;
      line += phases.map(p =>
        `  • ${p.code}: ${p.name}${p.is_counting_point ? " (COUNTING)" : ""}`
      ).join("\n");
      return line;
    }).join("\n");
  }
  if (singleStep.length > 0) {
    if (artSection) artSection += "\n\n";
    artSection += `ARTICOLI SENZA FASI — assegna solo article_code, phase_code = null:\n`;
    artSection += singleStep.slice(0, 50).map(a => {
      const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
      return `- ${a.code} (${a.name})${kwPart}`;
    }).join("\n");
  }
  if (multiStep.length > 0 || singleStep.length > 0) {
    artSection += `\n\nSe la fattura riguarda uno di questi materiali, assegna article_code e phase_code (se ha fasi). Se la fattura copre l'intero ciclo (dalla coltivazione al frantoio), usa la fase "ciclo completo". Per articoli senza fasi, imposta phase_code = null. Se non riesci a identificare il materiale, non assegnare nessun articolo.`;
  }

  // Categories (already direction-filtered)
  const catSection = categories
    .map((c) => `- ${c.id}: ${c.name} (${c.type})`)
    .join("\n");

  // Chart of accounts — split into primary (recommended) and secondary (edge cases)
  const coaPrimarySection = primaryAccounts
    .map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`)
    .join("\n");
  const coaSecondarySection = secondaryAccounts.length > 0
    ? secondaryAccounts
        .map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`)
        .join("\n")
    : "";

  // Cost centers
  const cdcSection =
    projects.length > 0
      ? projects.map((p) => `- ${p.id}: ${p.code} ${p.name}`).join("\n")
      : "Nessun centro di costo configurato.";

  // Counterparty classification history
  let historySection: string;
  if (history.length > 0) {
    const histLines = history.map((h) => {
      const parts: string[] = [`"${h.description}"`];
      if (h.article_code) {
        let artPart = `art: ${h.article_code} ${h.article_name || ""}`;
        if (h.phase_code) artPart += ` → fase: ${h.phase_code} (${h.phase_name || ""})`;
        parts.push(artPart);
      }
      if (h.category_name) parts.push(`cat: ${h.category_name}`);
      if (h.account_code) parts.push(`conto: ${h.account_code} ${h.account_name || ""}`);
      return parts.join(" → ");
    });
    historySection = `STORICO CLASSIFICAZIONI DI QUESTA CONTROPARTE (ultime confermate dall'utente):
ATTENZIONE: lo storico mostra classificazioni di righe PRECEDENTI. Usalo SOLO se la riga attuale descrive lo STESSO tipo di bene/servizio. Se la riga attuale è diversa (es. "opere edili" vs storico di "calcare"), classifica dalla descrizione attuale, NON dallo storico.
${histLines.join("\n")}`;
  } else {
    historySection =
      "Nessuno storico di classificazione per questa controparte.";
  }

  // RAG examples from other counterparties
  let ragSection = "";
  if (ragExamples.length > 0) {
    const ragLines = ragExamples.map(
      (r) =>
        `- "${r.output_label}" (similarità: ${(r.similarity * 100).toFixed(0)}%) meta: ${JSON.stringify(r.metadata)}`,
    );
    ragSection = `\nESEMPI SIMILI DA ALTRE CONTROPARTI (RAG):\n${ragLines.join("\n")}`;
  }

  // Lines
  const lineEntries = lines
    .map(
      (l, i) =>
        `${i + 1}. [line_id: ${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} prezzo_unit=${l.unit_price ?? "N/D"} totale=${l.total_price ?? "N/D"}`,
    )
    .join("\n");

  return `${systemPrompt}
${userInstructionsBlock}

## ARTICOLI DISPONIBILI
${artSection || "Nessun articolo configurato."}

CATEGORIE DISPONIBILI (filtrate per direzione fattura):
${catSection}

PIANO DEI CONTI — CONTI PRINCIPALI (USA QUESTI):
${coaPrimarySection}
${coaSecondarySection ? `
PIANO DEI CONTI — CONTI SPECIALI (usa SOLO per casi particolari: interessi, immobilizzazioni, straordinari):
${coaSecondarySection}` : ""}

CENTRI DI COSTO:
${cdcSection}

=== CONTROPARTE FORNITORE/CLIENTE ===
${counterpartyInfo}
REGOLA: Il NOME della controparte spesso rivela la sua attività principale (es. "FRANTOI MERIDIONALI" = frantumazione inerti, "AUTOTRASPORTI ROSSI" = trasporto). Usa il nome come indizio forte per guidare la classificazione quando la descrizione riga è generica.
===

${historySection}
${ragSection}

=== VINCOLO DIREZIONE FATTURA (OBBLIGATORIO — VIOLAZIONI = ERRORE GRAVE) ===
Questa fattura è: ${direction === "in" ? "PASSIVA (acquisto/costo)" : "ATTIVA (vendita/ricavo)"}
${direction === "in" ? `FATTURA PASSIVA → CONTI DI COSTO:
- category.type DEVE essere "expense" o "both" — MAI "revenue"
- account.section DEVE essere cost_production, cost_personnel, depreciation, other_costs
- Eccezionalmente ammessi: financial (interessi passivi 64xxx), assets (immobilizzazioni 21xxx)
- VIETATO assegnare conti con section "revenue" (70xxx) — ERRORE FATALE` : `FATTURA ATTIVA → CONTI DI RICAVO:
- category.type DEVE essere "revenue" o "both" — MAI "expense"
- account.section DEVE essere "revenue" (70xxx+)
- Eccezionalmente ammessi: financial (proventi finanziari 72xxx)
- VIETATO assegnare conti con section cost_production/cost_personnel/depreciation/other_costs (60xxx-69xxx) — ERRORE FATALE
- Ricavi tipici: 70000-70009 (vendita materiali), 70005 (servizi), 70006 (trasporto), 70007 (noleggio)`}
DOPO AVER CLASSIFICATO OGNI RIGA → VERIFICA che conto e categoria siano coerenti con la direzione.
===

REGOLE:
UTILIZZO DELLO STORICO CONTROPARTE:
  - Lo storico mostra classificazioni di righe precedenti. NON copiarlo ciecamente.
  - Per OGNI riga attuale, confronta la DESCRIZIONE con le descrizioni nello storico.
  - Se la descrizione attuale corrisponde semanticamente a una riga storica (stesso tipo di bene/servizio) → usa la stessa classificazione con confidence 85-95
  - Se la descrizione attuale è DIVERSA (es. storico: "calcare", riga: "trasporto") → classifica dalla descrizione attuale, ignora lo storico per quella riga
  - Se la controparte ha storico misto (più categorie/conti diversi), NON scegliere la più frequente — scegli quella che corrisponde alla DESCRIZIONE ATTUALE
  - Se hai dubbi, classifica dalla descrizione. È meglio una classificazione corretta con confidence 70 che una copiata dallo storico con confidence 90 ma sbagliata
* Se ATECO disponibile → usalo per guidare categoria e conto
* TRASPORTO/TRASPORTI nella descrizione → servizio di trasporto, NON il materiale
* NOLO/NOLEGGIO → è noleggio, non acquisto
* FORNITURA/VENDITA → è il materiale/prodotto
* article_code: assegna SOLO se la riga riguarda uno degli articoli configurati, altrimenti null
* phase_code: se l'articolo ha fasi, assegna la fase più appropriata dal suo elenco. Se l'articolo non ha fasi, phase_code = null.
* category_id e account_id: assegna SEMPRE

RIGHE CON IMPORTO ZERO (CONTESTO):
* Le righe con total_price=0 e unit_price=0 sono righe informative/di contesto, NON righe da classificare come costo/ricavo
* Queste righe spesso contengono riferimenti importanti: numero cantiere, contratto, commessa, materiale oggetto della fornitura
* USA le informazioni di queste righe per classificare meglio le righe con importo > 0
* Per le righe zero stesse: assegna category_id e account_id coerenti con il contesto, confidence bassa (30-50), reasoning: "Riga informativa/contesto"

CATEGORY MATCHING — ABBASSA CONFIDENCE SE NESSUNA CATEGORIA CORRISPONDE:
* Se NESSUNA delle categorie nella lista filtrata corrisponde bene alla riga, NON forzare una categoria sbagliata con confidence alta
* Invece: scegli la categoria più vicina disponibile MA abbassa la confidence sotto 70 per attivare l'escalation, dove il classificatore avanzato ha la lista COMPLETA delle categorie
* Esempio: se la riga è "servizio di facchinaggio" ma nessuna categoria è specifica per facchinaggio → assegna la più vicina (es. "Servizi generali") ma con confidence 55-65 e reasoning: "Nessuna categoria specifica trovata"

ATTENZIONE — ERRORE FREQUENTE DA EVITARE (SERVIZI vs MATERIALI):
* PRIMA analizza la DESCRIZIONE della riga. Solo DOPO controlla lo storico.
* Se la descrizione contiene "opere edili", "lavori", "manutenzione", "installazione", "realizzazione", "ripristino", "costruzione", "demolizione" → è un SERVIZIO/LAVORO, NON un materiale
* NON assegnare articoli di materiale (calcare, pozzolana, inerti, pietrisco, ghiaia, sabbia) a righe che descrivono servizi/lavori/opere
* Esempio SBAGLIATO: riga "OPERE EDILI PER REALIZZAZIONE CABINA" → article_code: "calcare" ← ERRORE GRAVE!
* Esempio CORRETTO: riga "OPERE EDILI PER REALIZZAZIONE CABINA" → article_code: null, categoria: servizi/lavori edili
* Anche se lo STORICO della controparte mostra quasi sempre "calcare", se la riga attuale parla di SERVIZI → article_code = null

FASI ARTICOLO — REGOLE:
* Quando assegni un articolo che ha fasi, DEVI SEMPRE assegnare anche phase_code. Non lasciare phase_code = null per articoli con fasi.
* Usa la DESCRIZIONE della riga fattura per capire la fase:
  - "estrazione" / "scavo" / "coltivazione" → fase di estrazione/coltivazione
  - "trasporto" / "carico" / "consegna" → fase di trasporto
  - "ciclo completo" / "dalla cava al frantoio" → fase ciclo completo
  - "fresatura" / "frantumazione" → fase di frantumazione/fresatura
  - "vendita" / "fornitura" / "cessione" → fase di vendita diretta
* Usa lo STORICO: se la stessa controparte con descrizione simile ha avuto una fase specifica, SEGUI LO STORICO
* Se non riesci a determinare la fase dalla descrizione, scegli la fase più comune dallo storico per quella controparte/articolo
* confidence 0-100

EXPERTISE CONTABILE ITALIANA — REGOLE FISCALI DA APPLICARE:

DEDUCIBILITA DIFFERENZIATA (CRITICO — scegli il conto giusto in base alla percentuale):
Questa azienda ha conti separati per diverse percentuali di deducibilità. DEVI scegliere il conto con la percentuale corretta:
* Carburanti automezzi da trasporto (camion, escavatori, pale) → 60812 "Carburanti 100%"
* Carburanti auto aziendali (autovetture, SUV) → 608124 "Carburanti 20%"
* Manutenzione automezzi da trasporto → 60720 "Manutenzione automezzi 100%"
* Manutenzione auto aziendali → 607204 "Manutenzione automezzi 20%"
* Assicurazione automezzi da trasporto → 60822 "Assicurazioni automezzi 100%"
* Assicurazione auto aziendali → 608224 "Assicurazioni automezzi 20%"
* Tassa possesso automezzi da trasporto → 63207 "Tassa possesso 100%"
* Tassa possesso auto aziendali → 632074 "Tassa possesso 20%"
* Spese telefoniche → 608530 "Spese telefoniche 80%" (sempre 80%)
* Ristorazione e pernottamenti → 608150 "Spese ristoranti/pernott. 75%" (sempre 75%)
* Spese di rappresentanza → 60892 (deducibilità variabile in base al fatturato)
Come distinguere 100% da 20%:
* Se la controparte ha ATECO nel settore trasporti (49.xx) o commercio carburanti (47.30) e l'azienda è di autotrasporto/cave → 100%
* Se la fattura riguarda un'autovettura specifica (targa auto, non camion) → 20%
* Se non è chiaro, usa 100% per automezzi specifici/da lavoro e 20% per auto generiche
* I mezzi specifici della cava (escavatori, pale, mezzi di sollevamento) sono SEMPRE 100%

RITENUTA D'ACCONTO:
* Fatture da professionisti (avvocati, consulenti, geometri, ingegneri, notai — ATECO 69.xx, 71.xx, 74.xx) → segnala "Ritenuta acconto 20% su imponibile"
* Il costo va sul conto appropriato (60730 consulenza amm/fiscale, 6073201 consulenze legali, 607320 consulenze tecniche, 6073202 consulenze notarili)
* Non serve un conto separato per la ritenuta nella classificazione (sarà gestito in prima nota)

LEASING:
* Ogni contratto di leasing ha il suo conto dedicato (609xxxx) e il suo conto interessi (6094xxx)
* Se la fattura è di CREDEMLEASING, MPS Leasing, Daimler Truck Financial, BNP, Alba Leasing, Mercedes-Benz Financial → cerca il numero contratto nella descrizione e abbina al conto leasing corrispondente
* Se non trovi il numero contratto, usa il conto leasing generico 6093 "Canoni Leasing"
* Gli interessi su leasing vanno sempre su 6094xxx (section: financial), MAI sullo stesso conto del canone

REVERSE CHARGE (art. 17 c.6 DPR 633/72):
* Fatture per servizi edili tra imprese (subappalti) — controparte con ATECO 41.xx, 42.xx, 43.xx
* Se la fattura NON ha IVA esposta ma il fornitore è un'impresa edile → possibile reverse charge
* Segnala nel reasoning: "Possibile reverse charge art.17 c.6 — verificare registrazione IVA"

SPLIT PAYMENT (art. 17-ter DPR 633/72):
* Fatture ATTIVE verso la Pubblica Amministrazione (controparte con legal_type = 'pa')
* L'IVA non viene incassata dal fornitore → segnala nel reasoning

BENI STRUMENTALI vs COSTI D'ESERCIZIO:
* Acquisto di macchinari, automezzi, attrezzature, mobili con importo significativo (> 516,46 euro) → NON è un costo d'esercizio, va su un conto immobilizzazioni (21xxx)
* Acquisti sotto 516,46 euro → conto 21360 "Beni strumentali inferiore unità minima" oppure direttamente a costo
* Se il bene è chiaramente un immobilizzazione (camion, escavatore, computer) → segnala nel reasoning anche se non puoi assegnare il conto patrimoniale in questa fase

UTENZE E SERVIZI:
* Bollette energia → 60830
* Bollette gas → 60831
* Acquedotto → 60836
* Telefonia → 608530 (80%)
* Internet/provider → 6085301
* Smaltimento rifiuti → 60872

CONTABILITA SPECIFICA CAVE E INERTI:
* Questa è un'azienda di cave e inerti (ATECO 089909)
* I ricavi principali sono: vendita pozzolana (70000), calcare frantumato (70002), minerale calcare (70003), materiale da estrazione (70004), servizi (70005), trasporto (70006), noleggio (70007), manutenzione mezzi (70008), scopertura cave (70009)
* I costi specifici includono: locazione cava (6090020), esplosivo (rimborsato come ricavo 7063001), trasporti su acquisti (60412) e vendite (60810)
* Distingui SEMPRE tra "trasporto su acquisto" (60412 — il fornitore ci porta la merce) e "trasporto per vendita" (60810 — noi portiamo merce al cliente) e "spese di trasporto generiche" (60702)

ASSEGNAZIONE CENTRO DI COSTO — RAGIONAMENTO INTELLIGENTE:
Per scegliere il CdC corretto, NON indovinare. Ragiona usando TUTTE le informazioni disponibili:
1. STORICO CONTROPARTE (PRIORITÀ MASSIMA): se la stessa controparte è stata classificata su un CdC specifico nelle classificazioni precedenti confermate dall'utente, SEGUI LO STORICO. È il segnale più forte.
2. INDIRIZZO/LOCALITÀ CONTROPARTE: l'indirizzo della controparte indica dove avviene il servizio o da dove arriva la fornitura. Confronta la provincia/città della controparte con i nomi e codici dei CdC disponibili. Se un CdC ha nel nome una località che corrisponde alla zona della controparte, è probabilmente quello giusto.
3. ATECO CONTROPARTE: il codice ATECO della controparte indica il tipo di attività. Usa questa informazione per capire il contesto: un fornitore edile probabilmente serve un cantiere, un fornitore di carburante serve i mezzi di un sito specifico.
4. ARTICOLI DELLA FATTURA: se le righe fattura sono state associate a un articolo che è specifico di un sito/CdC (es. materiale estratto in un sito specifico), il CdC dovrebbe corrispondere a quel sito.
5. DESCRIZIONE RIGHE: cerca riferimenti geografici nella descrizione delle righe fattura (nomi di cave, cantieri, sedi, città).
6. COSTI GENERALI: per spese non legate a un sito specifico (assicurazioni generali, consulenze fiscali/legali, abbonamenti SaaS, servizi centralizzati), usa il CdC che rappresenta la sede principale/corporate dell'azienda.
REGOLA CHIAVE: non assegnare il CdC "sede/corporate" per default quando ci sono indizi che il costo è legato a un sito specifico. Usa il ragionamento sopra per dedurre il CdC corretto.

RIGHE SCONTO / ABBUONO / AGGIUSTAMENTO PREZZO:
* Le righe con importo negativo o con descrizione che contiene "sconto", "abbuono", "superamento quantitativi", "riduzione prezzo", "aggiustamento", "rettifica" sono aggiustamenti commerciali, NON produzione.
* Se la riga sconto è chiaramente relativa a un articolo (es. "sconto su trasporto travertino"), assegna lo stesso articolo e la stessa fase della riga di produzione corrispondente. Questo serve per calcolare il prezzo medio netto per unità.
* Se la riga sconto è generica (es. "sconto commerciale" senza riferimento a un materiale specifico), NON assegnare articolo.
* La categoria e il conto possono essere quelli dell'articolo principale OPPURE un conto sconti specifico se presente nel piano dei conti (es. "Sconti su vendite", "Abbuoni attivi").
* Nel reasoning, segnala: "Riga sconto/abbuono — esclusa dal conteggio quantità nel report"

COERENZA CLASSIFICAZIONE:
* Se assegni un article_code, DEVI anche assegnare category_id e account_id coerenti. Se sai che è un certo materiale (hai assegnato l'articolo), hai sicuramente abbastanza contesto per assegnare anche categoria e conto.
* NON lasciare category_id o account_id null a meno che non abbia davvero nessun indizio. Se hai assegnato articolo e CdC, hai le informazioni per classificare completamente.
* Copia gli UUID ESATTAMENTE dalla lista. Come backup, compila SEMPRE anche category_name e account_code.

SANITY CHECK — VERIFICA COERENZA PRIMA DI RISPONDERE:
Prima di finalizzare ogni riga, verifica:
1. La DESCRIZIONE della riga parla di X (es. "trasporto", "calcare", "opere edili", "noleggio")
2. La CATEGORIA/CONTO che hai assegnato è coerente con X? Se la riga dice "trasporto" ma hai assegnato conto "acquisto materie prime" → ERRORE, correggi.
3. L'ARTICOLO che hai assegnato è coerente con la descrizione? Se la riga dice "noleggio escavatore" ma hai assegnato articolo "Calcare" → ERRORE, correggi.
4. Se la riga NON corrisponde a nessun articolo configurato, lascia article_code = null. Non forzare un articolo sbagliato.
5. Se lo storico suggerisce una classificazione diversa dalla descrizione attuale, SEGUI LA DESCRIZIONE.
Nel reasoning, spiega BREVEMENTE perché la classificazione è coerente con la descrizione (max 30 parole).

FATTURA: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}

RIGHE DA CLASSIFICARE:
${lineEntries}

Rispondi con un array JSON (senza markdown):
[{
  "line_id": "uuid",
  "article_code": "CODICE" o null,
  "phase_code": "extraction" o null,
  "category_id": "uuid",
  "category_name": "nome esatto della categoria come scritto nella lista (fallback)",
  "account_id": "uuid",
  "account_code": "codice numerico del conto come scritto nella lista (fallback)",
  "cost_center_allocations": [{"project_id": "uuid", "percentage": 100}],
  "confidence": 0-100,
  "reasoning": "spiegazione breve max 30 parole",
  "fiscal_flags": {
    "ritenuta_acconto": null oppure {"aliquota": 20, "base": "imponibile"},
    "reverse_charge": false,
    "split_payment": false,
    "bene_strumentale": false,
    "deducibilita_pct": 100,
    "iva_detraibilita_pct": 100,
    "note": null oppure "eventuale nota fiscale"
  },
  "suggest_new_account": null oppure {"code": "180.50", "name": "Canoni leasing escavatore", "section": "cost_production", "parent_code": "180", "reason": "motivo in italiano"},
  "suggest_new_category": null oppure {"name": "Noleggio attrezzature", "type": "expense", "reason": "motivo in italiano"}
}]
---KEYWORDS---
["keyword1", "keyword2", ...] (5-10 keywords di ricerca per questa fattura)`;
}

/* ─── Compose invoice-level from line results ── */

function composeInvoiceLevel(
  lineResults: SonnetLineResult[],
  lines: InputLine[],
): {
  category_id: string | null;
  account_id: string | null;
  project_allocations: { project_id: string; percentage: number }[];
  confidence: number;
  reasoning: string;
} {
  if (lineResults.length === 0) {
    return {
      category_id: null,
      account_id: null,
      project_allocations: [],
      confidence: 0,
      reasoning: "Nessuna riga classificata",
    };
  }

  // Category: most common (weighted by total_price)
  const catW = new Map<string, number>();
  for (const lr of lineResults) {
    if (!lr.category_id) continue;
    const line = lines.find((l) => l.line_id === lr.line_id);
    const w = Math.abs(line?.total_price || 1);
    catW.set(lr.category_id, (catW.get(lr.category_id) || 0) + w);
  }
  let bestCat: string | null = null;
  let bestCatW = 0;
  for (const [cat, w] of catW) {
    if (w > bestCatW) {
      bestCat = cat;
      bestCatW = w;
    }
  }

  // Account: most common (weighted)
  const accW = new Map<string, number>();
  for (const lr of lineResults) {
    if (!lr.account_id) continue;
    const line = lines.find((l) => l.line_id === lr.line_id);
    const w = Math.abs(line?.total_price || 1);
    accW.set(lr.account_id, (accW.get(lr.account_id) || 0) + w);
  }
  let bestAcc: string | null = null;
  let bestAccW = 0;
  for (const [acc, w] of accW) {
    if (w > bestAccW) {
      bestAcc = acc;
      bestAccW = w;
    }
  }

  // Projects: aggregate
  const projMap = new Map<string, number>();
  for (const lr of lineResults) {
    for (const pa of lr.cost_center_allocations || []) {
      projMap.set(
        pa.project_id,
        (projMap.get(pa.project_id) || 0) + pa.percentage,
      );
    }
  }
  const totalPct = [...projMap.values()].reduce((s, v) => s + v, 0);
  const projectAllocations = [...projMap.entries()].map(([id, pct]) => ({
    project_id: id,
    percentage: totalPct > 0 ? Math.round((pct / totalPct) * 100) : 100,
  }));

  // Confidence: weighted average
  let totalWeight = 0;
  let confSum = 0;
  for (const lr of lineResults) {
    const line = lines.find((l) => l.line_id === lr.line_id);
    const w = Math.abs(line?.total_price || 1);
    confSum += lr.confidence * w;
    totalWeight += w;
  }
  const avgConf = totalWeight > 0 ? Math.round(confSum / totalWeight) : 0;

  return {
    category_id: bestCat,
    account_id: bestAcc,
    project_allocations: projectAllocations,
    confidence: avgConf,
    reasoning: `${lineResults.length} righe classificate. Confidenza media: ${avgConf}%.`,
  };
}

/* ─── Persist results ───────────────────── */

async function persistResults(
  sql: SqlClient,
  companyId: string,
  invoiceId: string,
  lineResults: SonnetLineResult[],
  invoiceLevel: ReturnType<typeof composeInvoiceLevel>,
  articles: ArticleRow[],
  phases: ArticlePhaseRow[],
): Promise<void> {
  const codeToId = new Map(articles.map((a) => [a.code, a.id]));
  let persisted = 0;

  for (const lr of lineResults) {
    if (lr.confidence < MIN_CONFIDENCE) continue;

    // Resolve article_code → article_id
    const articleId = lr.article_code ? (codeToId.get(lr.article_code) || null) : null;

    // Resolve phase_code → phase_id
    let phaseId: string | null = null;
    if (articleId && lr.phase_code) {
      const match = phases.find(p => p.article_id === articleId && p.code === lr.phase_code);
      if (match) phaseId = match.id;
    }

    // Save line-level category/account + mark as ai_suggested
    if (lr.category_id || lr.account_id) {
      try {
        await sql`
          UPDATE invoice_lines
          SET category_id = COALESCE(${lr.category_id}, category_id),
              account_id = COALESCE(${lr.account_id}, account_id),
              classification_status = 'ai_suggested'
          WHERE id = ${lr.line_id}
            AND (category_id IS NULL OR account_id IS NULL)`;
      } catch (e: unknown) {
        console.error(`[persist] line ${lr.line_id} UPDATE invoice_lines failed:`, (e as Error).message);
      }
    }

    // Save article suggestion as unverified (with phase_id if resolved)
    if (articleId) {
      try {
        await sql`
          INSERT INTO invoice_line_articles
            (company_id, invoice_id, invoice_line_id, article_id, phase_id, assigned_by, verified, confidence)
          VALUES (${companyId}, ${invoiceId}, ${lr.line_id}, ${articleId}, ${phaseId}, 'ai_classification', false, ${lr.confidence})
          ON CONFLICT (invoice_line_id) DO NOTHING`;
      } catch (e: unknown) {
        console.error(`[persist] line ${lr.line_id} INSERT invoice_line_articles failed:`, (e as Error).message);
      }
    }

    // Save line-level CdC allocations
    for (const pa of lr.cost_center_allocations || []) {
      try {
        await sql`
          INSERT INTO invoice_line_projects
            (company_id, invoice_id, invoice_line_id, project_id, percentage, assigned_by)
          VALUES (${companyId}, ${invoiceId}, ${lr.line_id}, ${pa.project_id}, ${pa.percentage}, 'ai_auto')
          ON CONFLICT DO NOTHING`;
      } catch (e: unknown) {
        console.error(`[persist] line ${lr.line_id} INSERT invoice_line_projects failed:`, (e as Error).message);
      }
    }
    persisted++;
  }

  console.log(`[persist] ${persisted} lines persisted`);

  // Save invoice-level classification as unverified suggestion
  if (
    invoiceLevel.confidence >= MIN_CONFIDENCE &&
    (invoiceLevel.category_id || invoiceLevel.account_id)
  ) {
    try {
      await sql`
        INSERT INTO invoice_classifications
          (company_id, invoice_id, category_id, account_id, assigned_by, verified, ai_confidence, ai_reasoning)
        VALUES (${companyId}, ${invoiceId}, ${invoiceLevel.category_id}, ${invoiceLevel.account_id},
                'ai_auto', false, ${invoiceLevel.confidence}, ${invoiceLevel.reasoning})
        ON CONFLICT (invoice_id) DO NOTHING`;
    } catch (e: unknown) {
      console.error(`[persist] INSERT invoice_classifications failed:`, (e as Error).message);
    }
  }

  // Save invoice-level CdC allocations
  for (const pa of invoiceLevel.project_allocations) {
    try {
      await sql`
        INSERT INTO invoice_projects
          (company_id, invoice_id, project_id, percentage, assigned_by)
        VALUES (${companyId}, ${invoiceId}, ${pa.project_id}, ${pa.percentage}, 'ai_auto')
        ON CONFLICT DO NOTHING`;
    } catch (e: unknown) {
      console.error(`[persist] INSERT invoice_projects failed:`, (e as Error).message);
    }
  }
}

/* ─── Main handler ──────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!apiKey)
    return json({ error: "ANTHROPIC_API_KEY non configurata" }, 503);

  let body: {
    company_id?: string;
    invoice_id?: string;
    lines?: InputLine[];
    direction?: string;
    counterparty_vat_key?: string;
    counterparty_name?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  const invoiceId = body.invoice_id;
  const inputLines = body.lines || [];
  const direction = body.direction || "in";
  const counterpartyVatKey = body.counterparty_vat_key || null;
  const counterpartyName = body.counterparty_name || "";

  if (!companyId) return json({ error: "company_id richiesto" }, 400);
  if (!invoiceId) return json({ error: "invoice_id richiesto" }, 400);
  if (inputLines.length === 0)
    return json({ error: "lines array vuoto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // ─── Load all context in parallel ───────────────────
    const [articles, allCategories, allAccounts, projects, phases] = await Promise.all([
      sql<ArticleRow[]>`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql<CategoryRow[]>`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true ORDER BY sort_order, name`,
      sql<AccountRow[]>`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false ORDER BY code`,
      sql<ProjectRow[]>`SELECT id, code, name FROM projects WHERE company_id = ${companyId} AND status = 'active' ORDER BY code`,
      sql<ArticlePhaseRow[]>`SELECT id, article_id, code, name, phase_type, is_counting_point, invoice_direction FROM article_phases WHERE company_id = ${companyId} AND active = true ORDER BY article_id, sort_order`,
    ]);

    // ─── Filter categories and accounts by direction ────
    const dirSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];
    const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
    // Direction-appropriate categories for prompt (allCategories kept for fallback resolution)
    const categories = allCategories.filter((c) => allowedCatTypes.includes(c.type));
    // Split accounts: primary (recommended) vs secondary (allowed in edge cases)
    const primaryAccounts = allAccounts.filter((a) => dirSections.primary.includes(a.section));
    const secondaryAccounts = allAccounts.filter(
      (a) => dirSections.allowed.includes(a.section) && !dirSections.primary.includes(a.section),
    );
    console.log(`[classify] direction=${direction}: ${categories.length}/${allCategories.length} cats, ${primaryAccounts.length} primary + ${secondaryAccounts.length} secondary accounts`);

    // ─── Counterparty ATECO info ────────────────────────
    let counterpartyInfo = counterpartyName || "N.D.";
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey
        .toUpperCase()
        .replace(/^IT/i, "")
        .replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [atecoRow] = await sql`
          SELECT ateco_code, ateco_description, business_sector, legal_type, address
          FROM counterparties
          WHERE company_id = ${companyId} AND vat_key = ${vatKey}
          LIMIT 1`;
        if (atecoRow) {
          const parts = [`P.IVA: ${counterpartyVatKey}`];
          if (atecoRow.ateco_code) {
            parts.push(`Codice ATECO: ${atecoRow.ateco_code}`);
            if (atecoRow.ateco_description)
              parts.push(atecoRow.ateco_description);
          }
          if (atecoRow.business_sector)
            parts.push(`Settore: ${atecoRow.business_sector}`);
          if (atecoRow.legal_type) parts.push(`Tipo: ${atecoRow.legal_type}`);
          if (atecoRow.address)
            parts.push(`Sede: ${atecoRow.address}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // ─── Counterparty classification history (direction-filtered) ──
    let history: HistoryRow[] = [];
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey
        .toUpperCase()
        .replace(/^IT/i, "")
        .replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        // First: load history matching the SAME direction (prevents cost/revenue bias)
        history = (await sql`
          SELECT il.description, c.name as category_name, a.code as account_code, a.name as account_name,
                 art.code as article_code, art.name as article_name,
                 ap.code as phase_code, ap.name as phase_name,
                 null::jsonb as cost_center_allocations
          FROM invoice_lines il
          JOIN invoices i ON il.invoice_id = i.id
          LEFT JOIN categories c ON il.category_id = c.id
          LEFT JOIN chart_of_accounts a ON il.account_id = a.id
          LEFT JOIN invoice_line_articles ila ON ila.invoice_line_id = il.id
          LEFT JOIN articles art ON ila.article_id = art.id
          LEFT JOIN article_phases ap ON ila.phase_id = ap.id
          WHERE i.company_id = ${companyId}
            AND i.direction = ${direction}
            AND i.counterparty_id = (
              SELECT id FROM counterparties
              WHERE vat_key = ${vatKey} AND company_id = ${companyId}
              LIMIT 1
            )
            AND i.classification_status = 'confirmed'
            AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
          ORDER BY i.date DESC
          LIMIT 30`) as HistoryRow[];
        // Fallback: if sparse history for this direction (<3 rows), supplement with all directions
        // This handles counterparties that are both suppliers and customers
        if (history.length < 3) {
          const allDirHistory = (await sql`
            SELECT il.description, c.name as category_name, a.code as account_code, a.name as account_name,
                   art.code as article_code, art.name as article_name,
                   ap.code as phase_code, ap.name as phase_name,
                   null::jsonb as cost_center_allocations
            FROM invoice_lines il
            JOIN invoices i ON il.invoice_id = i.id
            LEFT JOIN categories c ON il.category_id = c.id
            LEFT JOIN chart_of_accounts a ON il.account_id = a.id
            LEFT JOIN invoice_line_articles ila ON ila.invoice_line_id = il.id
            LEFT JOIN articles art ON ila.article_id = art.id
            LEFT JOIN article_phases ap ON ila.phase_id = ap.id
            WHERE i.company_id = ${companyId}
              AND i.direction != ${direction}
              AND i.counterparty_id = (
                SELECT id FROM counterparties
                WHERE vat_key = ${vatKey} AND company_id = ${companyId}
                LIMIT 1
              )
              AND i.classification_status = 'confirmed'
              AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
            ORDER BY i.date DESC
            LIMIT 10`) as HistoryRow[];
          if (allDirHistory.length > 0) {
            // Mark other-direction entries so the prompt can warn about them
            history = [...history, ...allDirHistory];
            console.log(`[classify] Supplemented history: ${history.length - allDirHistory.length} same-dir + ${allDirHistory.length} other-dir entries`);
          }
        }
      }
    }

    // ─── Load shared system prompt + user instructions ──
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
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

    const systemPrompt = getAccountingSystemPrompt(companyContext);
    const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);
    if (userInstructionsBlock) {
      console.log(`[classify-invoice-lines] Loaded user instructions`);
    }

    // ─── Stage 1: Embedding Pre-flight ──────────────────
    // Find relevant entities via semantic search instead of sending ALL
    let preflightAccounts: AccountRow[] = [...primaryAccounts, ...secondaryAccounts];
    let preflightCategories: CategoryRow[] = categories;
    let preflightArticles: ArticleRow[] = articles;
    let preflightProjects: ProjectRow[] = projects;
    let memoryFacts: MemoryFact[] = [];

    // Resolve counterparty_id for memory search
    let counterpartyId: string | null = null;
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        const [cpRow] = await sql`
          SELECT id FROM counterparties WHERE vat_key = ${vatKey} AND company_id = ${companyId} LIMIT 1
        `;
        if (cpRow) counterpartyId = cpRow.id;
      }
    }

    if (geminiKey && inputLines.length > 0) {
      const preflight = await embeddingPreflight(
        sql, companyId, inputLines, counterpartyName, counterpartyId,
        direction, geminiKey, dirSections, allowedCatTypes,
      );

      if (preflight) {
        // Cold-start detection: if ALL embedding queries returned empty, use full lists
        const totalPfResults = preflight.accounts.length + preflight.categories.length + preflight.articles.length;
        if (totalPfResults === 0) {
          console.log(`[classify] ❄ Cold-start: no embeddings found — using full entity lists`);
          // Keep defaults (full lists already assigned above)
        } else {
          // Use pre-flight results if sufficient
          if (preflight.accounts.length >= 5) {
            preflightAccounts = preflight.accounts;
          } else {
            // Supplement with primary accounts
            console.log(`[classify] Pre-flight returned only ${preflight.accounts.length} accounts, supplementing with primary accounts`);
            const pfIds = new Set(preflight.accounts.map(a => a.id));
            preflightAccounts = [
              ...preflight.accounts,
              ...primaryAccounts.filter(a => !pfIds.has(a.id)).slice(0, 15 - preflight.accounts.length),
            ];
          }
          if (preflight.categories.length >= 3) {
            preflightCategories = preflight.categories;
          }
          if (preflight.articles.length > 0) {
            preflightArticles = preflight.articles;
          }
          if (preflight.projects.length > 0) {
            preflightProjects = preflight.projects;
          }
        }
        // Always use memory facts if available
        memoryFacts = preflight.memoryFacts;
      }
    } else if (!geminiKey) {
      console.warn(`[classify] No GEMINI_API_KEY — skipping embedding pre-flight, using full lists`);
    }

    // Build memory block for prompt
    const memoryBlock = getCompanyMemoryBlock(memoryFacts);

    // ─── Stage 2: Haiku Classification ──────────────────
    const focusedPrompt = buildFocusedPrompt(
      preflightArticles,
      preflightCategories,
      preflightAccounts,
      preflightProjects,
      phases,
      counterpartyInfo,
      history,
      memoryBlock,
      direction,
      inputLines,
      systemPrompt,
      userInstructionsBlock,
    );

    console.log(
      `[classify-invoice-lines] Calling Haiku for ${inputLines.length} lines, invoice=${invoiceId}, cp=${counterpartyName}`,
    );

    const haikuResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 8192,
        messages: [{ role: "user", content: focusedPrompt }],
      }),
    });

    // Helper: call an AI model and parse the response
    async function callClassificationModel(model: string, prompt: string, label: string): Promise<{
      lineResults: SonnetLineResult[];
      keywords: string[];
    } | null> {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[classify-invoice-lines] ${label} API error:`, resp.status, errText.slice(0, 300));
        return null;
      }

      const data = await resp.json();
      const text = (data as any)?.content?.[0]?.text || "";
      console.log(`[classify-invoice-lines] ${label} response: ${text.length} chars`);

      let keywords: string[] = [];
      const keywordsSplit = text.split("---KEYWORDS---");
      const classJson = keywordsSplit[0].trim();
      if (keywordsSplit.length > 1) {
        try {
          const kwMatch = keywordsSplit[1].match(/\[[\s\S]*?\]/);
          if (kwMatch) keywords = JSON.parse(kwMatch[0]);
        } catch { /* ignore */ }
      }

      try {
        const jsonMatch = classJson.match(/\[[\s\S]*\]/);
        const parsed: SonnetLineResult[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        return { lineResults: parsed, keywords };
      } catch (e) {
        console.error(`[classify-invoice-lines] ${label} parse error:`, e, classJson.slice(0, 300));
        return null;
      }
    }

    // Try Haiku first, fall back to Sonnet on failure
    let classResult = await callClassificationModel(MODEL_HAIKU, focusedPrompt, "Haiku");
    let actualModel = MODEL_HAIKU;

    if (!classResult) {
      console.warn("[classify-invoice-lines] Haiku failed, falling back to Sonnet with focused prompt");
      classResult = await callClassificationModel(MODEL_SONNET, focusedPrompt, "Sonnet-fallback");
      actualModel = MODEL_SONNET;
    }

    if (!classResult) {
      return json({ error: "Both Haiku and Sonnet calls failed" }, 502);
    }

    let keywords = classResult.keywords;

    // Normalize results
    let lineResults: SonnetLineResult[] = classResult.lineResults.map((item) => ({
      line_id: item.line_id,
      article_code: item.article_code || null,
      phase_code: item.phase_code || null,
      category_id: item.category_id || null,
      category_name: item.category_name || null,
      account_id: item.account_id || null,
      account_code: item.account_code || null,
      cost_center_allocations: item.cost_center_allocations || [],
      confidence: Math.min(
        Math.max(Number(item.confidence) || 50, 0),
        100,
      ),
      reasoning: item.reasoning || "",
      fiscal_flags: item.fiscal_flags || null,
      suggest_new_account: item.suggest_new_account || null,
      suggest_new_category: item.suggest_new_category || null,
    }));

    // ─── Stage 3: Sonnet Escalation for low-confidence lines ──
    const lowConfLines = lineResults.filter(lr => lr.confidence < ESCALATION_THRESHOLD);
    const highConfLines = lineResults.filter(lr => lr.confidence >= ESCALATION_THRESHOLD);

    if (lowConfLines.length > 0) {
      console.log(`[classify-invoice-lines] ${lowConfLines.length}/${lineResults.length} lines below threshold (${ESCALATION_THRESHOLD}), escalating to Sonnet`);

      const escalatedResults = await callSonnetEscalation(
        apiKey,
        lowConfLines,
        lineResults,
        inputLines,
        allAccounts,
        allCategories,
        articles,
        phases,
        projects,
        counterpartyInfo,
        history,
        memoryBlock,
        direction,
        systemPrompt,
        userInstructionsBlock,
      );

      // Merge: keep high-confidence Haiku results + escalated Sonnet results
      const escalatedMap = new Map(escalatedResults.map(r => [r.line_id, r]));
      lineResults = highConfLines.map(lr => lr);
      for (const lowLr of lowConfLines) {
        const escalated = escalatedMap.get(lowLr.line_id);
        lineResults.push(escalated || lowLr);
      }

      console.log(`[classify-invoice-lines] Merged: ${highConfLines.length} Haiku + ${escalatedResults.length} Sonnet`);
    } else {
      console.log(`[classify-invoice-lines] All ${lineResults.length} lines above threshold — no escalation needed`);
    }

    // ─── Phase validation ─────────────────────────────
    for (const lr of lineResults) {
      if (lr.article_code) {
        const article = articles.find((a) => a.code === lr.article_code);
        if (article) {
          const articlePhases = phases.filter((p) => p.article_id === article.id);
          // Article has phases but AI returned no phase → auto-assign default
          if (articlePhases.length > 0 && !lr.phase_code) {
            const sortedPhases = [...articlePhases].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
            const defaultPhase = sortedPhases.find(p => p.is_counting_point) || sortedPhases[0];
            if (defaultPhase) {
              lr.phase_code = defaultPhase.code;
              console.log(`[classify] Auto-assigned default phase "${defaultPhase.code}" for article ${lr.article_code} on line ${lr.line_id}`);
            } else {
              console.warn(`[classify] Article ${lr.article_code} has ${articlePhases.length} phases but could not determine default for line ${lr.line_id}`);
            }
          }
          // AI returned a phase that doesn't exist → nullify
          if (lr.phase_code && !articlePhases.find((p) => p.code === lr.phase_code)) {
            console.warn(`[classify] Invalid phase_code "${lr.phase_code}" for article ${lr.article_code} — nullifying`);
            lr.phase_code = null;
          }
        }
      }
    }

    // ─── Fallback: resolve category/account by name/code when UUID missing or invalid ───
    for (const lr of lineResults) {
      // Fallback category: prefer direction-filtered, then allCategories
      if (!lr.category_id || !allCategories.find((c) => c.id === lr.category_id)) {
        if (lr.category_name) {
          const nameLower = lr.category_name.toLowerCase().trim();
          // First: match in direction-filtered categories
          let match = categories.find((c) => c.name.toLowerCase().trim() === nameLower);
          // Fallback: match in all categories
          if (!match) match = allCategories.find((c) => c.name.toLowerCase().trim() === nameLower);
          if (match) {
            console.log(`[classify] Fallback category: "${lr.category_name}" → ${match.id}`);
            lr.category_id = match.id;
          }
        }
      }
      // Fallback account: prefer primary, then secondary, then allAccounts
      if (!lr.account_id || !allAccounts.find((a) => a.id === lr.account_id)) {
        if (lr.account_code) {
          let match = primaryAccounts.find((a) => a.code === lr.account_code);
          if (!match) match = secondaryAccounts.find((a) => a.code === lr.account_code);
          if (!match) match = allAccounts.find((a) => a.code === lr.account_code);
          if (match) {
            console.log(`[classify] Fallback account: "${lr.account_code}" → ${match.id}`);
            lr.account_id = match.id;
          }
        }
      }
    }

    // ─── Post-processing: suspicious classification detection ──
    // Log when AI may have blindly followed history instead of matching descriptions
    for (const lr of lineResults) {
      const inputLine = inputLines.find((l) => l.line_id === lr.line_id);
      if (!inputLine) continue;
      const desc = (inputLine.description || "").toLowerCase();

      // Check description vs account coherence heuristics
      if (lr.account_id) {
        const acc = allAccounts.find((a) => a.id === lr.account_id);
        if (acc) {
          const accName = acc.name.toLowerCase();
          // Flag: transport-related description but non-transport account
          const descTransport = /trasport|consegn|sped|vettor|carico/.test(desc);
          const accTransport = /trasport|sped|vettor/.test(accName);
          if (descTransport && !accTransport && !/noleggi|leasing|fermo/.test(accName)) {
            console.warn(`[classify-sanity] Line ${lr.line_id}: desc mentions trasporto ("${desc.slice(0, 50)}") but account "${acc.code} ${acc.name}" is not trasporto-related. Confidence: ${lr.confidence}`);
          }
          // Flag: rental/noleggio description but non-rental account
          const descRental = /noleggi|nolo|fermo macchina/.test(desc);
          const accRental = /noleggi|nolo/.test(accName);
          if (descRental && !accRental && !/trasport|leasing/.test(accName)) {
            console.warn(`[classify-sanity] Line ${lr.line_id}: desc mentions noleggio ("${desc.slice(0, 50)}") but account "${acc.code} ${acc.name}" is not noleggio-related. Confidence: ${lr.confidence}`);
          }
        }
      }

      // Check description vs article coherence
      if (lr.article_code) {
        const art = articles.find((a) => a.code === lr.article_code);
        if (art) {
          const artName = art.name.toLowerCase();
          // Flag: description clearly about a service but article is a material (or vice versa)
          const descService = /trasport|noleggi|servizi|consulenz|manutenzi|opere|lavori/.test(desc);
          const artService = /trasport|noleggi|servizi|consulenz|manutenzi/.test(artName);
          const artMaterial = /calcar|pozzolan|inert|ghiai|sabbia|pietr/.test(artName);
          if (descService && artMaterial && !artService) {
            console.warn(`[classify-sanity] Auto-correcting line ${lr.line_id}: desc mentions service ("${desc.slice(0, 50)}") but article "${lr.article_code} ${art.name}" is a material — removing article assignment`);
            lr.article_code = null;
            lr.phase_code = null;
            lr.confidence = Math.min(lr.confidence, 70);
          }
        }
      }
    }

    // ─── Level 1: Direction enforcement (hard safety net) ──────────
    // This is the last line of defense: if the AI returned cost accounts
    // for an active invoice (or revenue accounts for a passive one),
    // we auto-correct here. This catches 100% of direction errors.
    {
      const allowedSections = dirSections.allowed;
      const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
      let directionCorrections = 0;

      for (const lr of lineResults) {
        let accountCorrected = false;
        let categoryCorrected = false;

        // Check account section against direction
        if (lr.account_id) {
          const acc = allAccounts.find((a) => a.id === lr.account_id);
          if (acc && !allowedSections.includes(acc.section)) {
            console.warn(`[classify-direction] ⛔ Line ${lr.line_id}: account "${acc.code} ${acc.name}" (section=${acc.section}) is INVALID for direction=${direction} — removing`);
            // Try to auto-substitute with first primary account that matches
            const fallbackAcc = primaryAccounts.length > 0 ? primaryAccounts[0] : null;
            if (fallbackAcc) {
              lr.account_id = fallbackAcc.id;
              lr.account_code = fallbackAcc.code;
              console.log(`[classify-direction] → Auto-substituted with primary account "${fallbackAcc.code} ${fallbackAcc.name}"`);
            } else {
              lr.account_id = null;
              lr.account_code = null;
            }
            lr.confidence = Math.min(lr.confidence, 55);
            lr.reasoning = `[DIR-FIX] Conto originale incompatibile con fattura ${direction === "out" ? "attiva" : "passiva"} — sostituito. ${lr.reasoning}`;
            accountCorrected = true;
            directionCorrections++;
          }
        }

        // Check category type against direction
        if (lr.category_id) {
          const cat = allCategories.find((c) => c.id === lr.category_id);
          if (cat && !allowedCatTypes.includes(cat.type)) {
            console.warn(`[classify-direction] ⛔ Line ${lr.line_id}: category "${cat.name}" (type=${cat.type}) is INVALID for direction=${direction} — removing`);
            // Try to auto-substitute with first direction-filtered category
            const fallbackCat = categories.length > 0 ? categories[0] : null;
            if (fallbackCat) {
              lr.category_id = fallbackCat.id;
              lr.category_name = fallbackCat.name;
              console.log(`[classify-direction] → Auto-substituted with category "${fallbackCat.name}"`);
            } else {
              lr.category_id = null;
              lr.category_name = null;
            }
            if (!accountCorrected) {
              lr.confidence = Math.min(lr.confidence, 55);
            }
            categoryCorrected = true;
            directionCorrections++;
          }
        }

        // Level 5: Validate suggest_new_account/category against direction
        if (lr.suggest_new_account) {
          const suggestedSection = lr.suggest_new_account.section || "";
          if (suggestedSection && !allowedSections.includes(suggestedSection)) {
            console.warn(`[classify-direction] Nullifying suggest_new_account: section "${suggestedSection}" is invalid for direction=${direction}`);
            lr.suggest_new_account = null;
          }
        }
        if (lr.suggest_new_category) {
          const suggestedType = lr.suggest_new_category.type || "";
          if (suggestedType && !allowedCatTypes.includes(suggestedType)) {
            console.warn(`[classify-direction] Nullifying suggest_new_category: type "${suggestedType}" is invalid for direction=${direction}`);
            lr.suggest_new_category = null;
          }
        }
      }

      if (directionCorrections > 0) {
        console.warn(`[classify-direction] ⚠ Corrected ${directionCorrections} direction violations for invoice ${invoiceId} (direction=${direction})`);
      }
    }

    // ─── Compose invoice-level ─────────────────────────
    const invoiceLevel = composeInvoiceLevel(lineResults, inputLines);

    // ─── Persist to DB ─────────────────────────────────
    await persistResults(
      sql,
      companyId,
      invoiceId,
      lineResults,
      invoiceLevel,
      articles,
      phases,
    );

    // Mark invoice as ai_suggested + save keywords
    try {
      if (keywords.length > 0) {
        await sql`
          UPDATE invoices
          SET classification_status = 'ai_suggested',
              search_keywords = ${JSON.stringify(keywords)}::jsonb
          WHERE id = ${invoiceId}
            AND classification_status != 'confirmed'`;
      } else {
        await sql`
          UPDATE invoices
          SET classification_status = 'ai_suggested'
          WHERE id = ${invoiceId}
            AND classification_status != 'confirmed'`;
      }
    } catch (e: unknown) {
      console.error(`[persist] UPDATE invoices failed:`, (e as Error).message);
    }

    // Resolve article codes to IDs for the response
    const codeToId = new Map(articles.map((a) => [a.code, a.id]));

    // Build phase resolution map for response
    const phaseResolution = new Map<string, string>();
    for (const p of phases) phaseResolution.set(`${p.article_id}:${p.code}`, p.id);

    return json({
      invoice_id: invoiceId,
      lines: lineResults.map((lr) => {
        const articleId = lr.article_code ? codeToId.get(lr.article_code) || null : null;
        const phaseId = articleId && lr.phase_code
          ? phaseResolution.get(`${articleId}:${lr.phase_code}`) || null
          : null;
        return {
          ...lr,
          article_id: articleId,
          phase_id: phaseId,
        };
      }),
      invoice_level: invoiceLevel,
      keywords,
      stats: {
        total_lines: inputLines.length,
        classified: lineResults.filter(
          (r) => r.confidence >= MIN_CONFIDENCE,
        ).length,
        history_count: history.length,
        memory_facts_count: memoryFacts.length,
        escalated_to_sonnet: lowConfLines.length,
        model_primary: actualModel,
        model_escalation: lowConfLines.length > 0 ? MODEL_SONNET : null,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[classify-invoice-lines] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
