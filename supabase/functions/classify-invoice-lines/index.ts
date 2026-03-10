// classify-invoice-lines — Haiku + Extended Thinking classifier for invoice lines
// Single Haiku call with thinking budget for all classification. No escalation.
// Full context: articles, categories, CoA, CdC, ATECO, counterparty history, RAG.
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
const HAIKU_THINKING_BUDGET = 5000;  // Extended Thinking token budget for Haiku
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const MIN_CONFIDENCE = 60;

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
- Se NESSUNA categoria nella lista corrisponde bene alla riga, NON forzare una categoria sbagliata con confidence alta. Scegli la più vicina MA con confidence bassa (50-65).
- Il NOME della controparte rivela spesso l'attività: usalo come indizio forte.

RIGHE:
${lineEntries}

JSON array (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"confidence":0-100,"reasoning":"max 30 parole","fiscal_flags":{"ritenuta_acconto":null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]
---KEYWORDS---
["kw1","kw2",...] (5-10 keywords)`;
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

    // ─── Stage 2: Haiku with Extended Thinking ──────────
    const haikuResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 16000,
        thinking: {
          type: "enabled",
          budget_tokens: HAIKU_THINKING_BUDGET,
        },
        messages: [{ role: "user", content: focusedPrompt }],
      }),
    });

    if (!haikuResp.ok) {
      const errText = await haikuResp.text();
      console.error(`[classify-invoice-lines] Haiku API error:`, haikuResp.status, errText.slice(0, 300));
      return json({ error: "Classification failed" }, 502);
    }

    const haikuData = await haikuResp.json();
    const contentBlocks = (haikuData as any)?.content || [];

    // Log thinking for debug (truncated)
    const thinkingBlock = contentBlocks.find((b: any) => b.type === "thinking");
    if (thinkingBlock) {
      console.log(`[classify] Haiku thinking: ${(thinkingBlock.thinking || "").slice(0, 200)}...`);
    }

    // Extract text from response (Extended Thinking returns thinking + text blocks)
    const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
    const responseText = textBlocks.map((b: any) => b.text).join("") || "";
    console.log(`[classify-invoice-lines] Haiku+Thinking response: ${responseText.length} chars`);

    // Parse keywords
    let keywords: string[] = [];
    const keywordsSplit = responseText.split("---KEYWORDS---");
    const classJson = keywordsSplit[0].trim();
    if (keywordsSplit.length > 1) {
      try {
        const kwMatch = keywordsSplit[1].match(/\[[\s\S]*?\]/);
        if (kwMatch) keywords = JSON.parse(kwMatch[0]);
      } catch { /* ignore */ }
    }

    // Parse classification JSON
    let parsedResults: SonnetLineResult[] = [];
    try {
      const jsonMatch = classJson.match(/\[[\s\S]*\]/);
      parsedResults = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error(`[classify-invoice-lines] Haiku parse error:`, e, classJson.slice(0, 300));
      return json({ error: "Classification parse failed" }, 502);
    }

    // Normalize results
    let lineResults: SonnetLineResult[] = parsedResults.map((item) => ({
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

    console.log(`[classify-invoice-lines] ${lineResults.length} lines classified by Haiku+Thinking`);

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
        model: MODEL_HAIKU,
        thinking_enabled: true,
        thinking_budget: HAIKU_THINKING_BUDGET,
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
