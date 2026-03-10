// classify-invoice-lines — Haiku + Sonnet escalation pipeline for invoice lines
// Stage 1: Embedding pre-flight (Gemini) → Stage 2: Haiku classification (batched)
// → Stage 3: Sonnet escalation for fiscal-complex lines (ritenuta, RC, beni strum.)
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
const MODEL_SONNET = "claude-sonnet-4-6-20250514";
const THINKING_PER_LINE = 400;       // thinking budget per line
const MIN_THINKING_BUDGET = 2048;    // minimum thinking budget
const MAX_THINKING_BUDGET = 16000;   // maximum thinking budget
const SONNET_THINKING_BUDGET = 10000; // fixed thinking budget for Sonnet escalation
const MAX_LINES_PER_BATCH = 15;      // max lines per Haiku call
const MAX_PARALLEL_BATCHES = 3;      // max concurrent API calls
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const MIN_CONFIDENCE = 60;
// Escalation triggers are handled generically in needsSonnetEscalation()
// — no hardcoded ATECO codes or predefined trigger lists.

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
  counterpartyAteco?: string,
  invoiceNotes?: string,
): Promise<PreflightResult | null> {
  try {
    // Build query text from all line descriptions + counterparty + ATECO + notes
    // ATECO dramatically improves semantic matching (e.g. "49.41 Trasporto merci" shifts
    // the embedding vector toward transport/logistics instead of generic construction)
    const queryText =
      lines.map((l) => l.description).filter(Boolean).join(" | ") +
      ` | ${counterpartyName || "N/D"}` +
      (counterpartyAteco ? ` | ATECO: ${counterpartyAteco}` : "") +
      (invoiceNotes ? ` | Note: ${invoiceNotes.slice(0, 200)}` : "");

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
  classifyOnlyLineIds?: Set<string>,
  invoiceNotes?: string,
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

  // Lines — with context markers when batching
  const hasBatchFilter = classifyOnlyLineIds && classifyOnlyLineIds.size > 0;
  const lineEntries = lines
    .map((l, i) => {
      const isContext = hasBatchFilter && !classifyOnlyLineIds!.has(l.line_id);
      const marker = isContext ? "[CONTESTO] " : (hasBatchFilter ? "[DA CLASSIFICARE] " : "");
      return `${i + 1}. ${marker}[${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}`;
    })
    .join("\n");

  // Batch instruction when using context markers
  const batchInstruction = hasBatchFilter
    ? `\nIMPORTANTE: Classifica SOLO le righe marcate [DA CLASSIFICARE]. Le righe [CONTESTO] sono informative — usale per capire il contesto (cantiere, commessa, tipologia lavoro) ma NON includerle nel JSON output.\n`
    : "";

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

- CdC: assegna SOLO se hai un segnale chiaro (storico controparte, cantiere nella descrizione, località). Se non sei sicuro, lascia cost_center_allocations vuoto — l'utente lo assegnerà manualmente.
- DUBBI FISCALI — REGOLA CRITICA: per OGNI riga, valuta attentamente deducibilita_pct e iva_detraibilita_pct usando le regole TUIR nel system prompt. NON mettere 100/100 di default. Ragiona: chi è la controparte (ATECO)? Che tipo di bene/servizio è? Per quale mezzo/uso è destinato? Se hai anche un MINIMO dubbio sulla percentuale corretta, ABBASSA la confidence sotto 65 e scrivi nel reasoning "Verificare: [motivo]". Questo è fondamentale perché attiva una verifica approfondita automatica. Esempi di dubbi da segnalare: deducibilità auto 20% vs mezzo trasporto 100%, IVA indetraibile parziale, possibile ritenuta d'acconto, possibile reverse charge, bene strumentale vs costo d'esercizio.
- COERENZA FISCALE FATTURA: PRIMA di classificare le singole righe, analizza l'INTERA fattura come un insieme. Guarda: chi è la controparte (ATECO)? Che tipo di beni/servizi sono? Per quale uso/mezzo sono destinati? Le percentuali di deducibilità e IVA detraibile devono essere COERENTI tra tutte le righe della stessa fattura che riguardano lo stesso tipo di operazione. NON è possibile avere 20% su un paraurti e 100% su un braccio oscillante dello stesso veicolo. Decidi il trattamento fiscale a livello fattura, poi applicalo uniformemente. Se stai classificando un sottoinsieme di righe (vedi righe [CONTESTO]), usa le righe contesto per determinare il trattamento fiscale dell'intera fattura PRIMA di classificare le tue righe.
${invoiceNotes ? `\n=== NOTE UTENTE SULLA FATTURA ===\n${invoiceNotes}\nQueste note sono dell'utente e hanno PRIORITÀ MASSIMA sulla classificazione.\n===\n` : ""}${batchInstruction}
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

    // Save line-level category/account/fiscal_flags + mark as ai_suggested
    if (lr.category_id || lr.account_id) {
      try {
        // Ensure fiscal_flags is a JSON string, not double-serialized
        const fiscalJson = lr.fiscal_flags
          ? (typeof lr.fiscal_flags === 'string' ? lr.fiscal_flags : JSON.stringify(lr.fiscal_flags))
          : null;
        await sql`
          UPDATE invoice_lines
          SET category_id = COALESCE(${lr.category_id}, category_id),
              account_id = COALESCE(${lr.account_id}, account_id),
              fiscal_flags = COALESCE(${fiscalJson}::jsonb, fiscal_flags),
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

/* ─── Sonnet escalation: detect lines needing fiscal expert ──── */
// Generalist approach — no hardcoded ATECO codes.
// Escalation triggers on Haiku's OWN signals: flags, confidence, doubt words, suggestions.

const DOUBT_PATTERN = /verificar|dubbio|potrebbe|incert|controllare|attenzione|non chiaro|ambiguo|da valutare|possibile|eventuale/i;

function needsSonnetEscalation(lr: SonnetLineResult): boolean {
  // Low confidence → escalate (raised threshold from 60 to 65)
  if (lr.confidence < 65) return true;

  // Non-standard fiscal flags → escalate for expert review
  const ff = lr.fiscal_flags;
  if (ff) {
    if (ff.ritenuta_acconto) return true;
    if (ff.reverse_charge) return true;
    if (ff.bene_strumentale) return true;
  }

  // Haiku signals doubt in reasoning → escalate
  if (lr.reasoning && DOUBT_PATTERN.test(lr.reasoning)) return true;

  // Suggest new account or category = Haiku unsure about CoA → escalate
  if (lr.suggest_new_account) return true;
  if (lr.suggest_new_category) return true;

  return false;
}

async function sonnetEscalate(
  escalationLines: SonnetLineResult[],
  allLines: InputLine[],
  accounts: AccountRow[],
  categories: CategoryRow[],
  projects: ProjectRow[],
  articles: ArticleRow[],
  phases: ArticlePhaseRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  memoryBlock: string,
  direction: string,
  systemPrompt: string,
  userInstructionsBlock: string,
  apiKey: string,
  invoiceNotes?: string,
): Promise<{ lineResults: SonnetLineResult[]; error?: string }> {
  // Build a Sonnet prompt with full context + Haiku's attempt as reference
  const lineIds = new Set(escalationLines.map(l => l.line_id));

  // Haiku attempt summary for Sonnet to review
  const haikuAttempts = escalationLines.map(lr => {
    const input = allLines.find(l => l.line_id === lr.line_id);
    return `- [${lr.line_id}] "${input?.description || 'N/D'}" → Haiku: conto=${lr.account_code || 'N/D'}, cat=${lr.category_name || 'N/D'}, confidence=${lr.confidence}, reasoning="${lr.reasoning}"${lr.fiscal_flags?.ritenuta_acconto ? ', RITENUTA ACCONTO' : ''}${lr.fiscal_flags?.reverse_charge ? ', REVERSE CHARGE' : ''}${lr.fiscal_flags?.bene_strumentale ? ', BENE STRUMENTALE' : ''}`;
  }).join("\n");

  // Full account/category lists for Sonnet (not pre-filtered — give it everything)
  const accSection = accounts.map(a => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n");
  const catSection = categories.map(c => `- ${c.id}: ${c.name} (${c.type})`).join("\n");
  const cdcSection = projects.length > 0
    ? projects.map(p => `- ${p.id}: ${p.code} ${p.name}`).join("\n")
    : "Nessun CdC.";

  // Articles section
  const phasesByArticle = new Map<string, ArticlePhaseRow[]>();
  for (const p of phases) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
    phasesByArticle.get(p.article_id)!.push(p);
  }
  let artSection = "";
  for (const a of articles) {
    const aPhases = phasesByArticle.get(a.id) || [];
    const kwPart = a.keywords?.length ? ` [${a.keywords.join(", ")}]` : "";
    if (aPhases.length > 0) {
      artSection += `- ${a.code} (${a.name})${kwPart}: ${aPhases.map(p => `${p.code}:${p.name}`).join(", ")}\n`;
    } else {
      artSection += `- ${a.code} (${a.name})${kwPart}\n`;
    }
  }

  // All line descriptions for context
  const lineContext = allLines.map((l, i) => {
    const isTarget = lineIds.has(l.line_id);
    return `${i + 1}. ${isTarget ? "[DA RICLASSIFICARE] " : "[CONTESTO] "}[${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}`;
  }).join("\n");

  const sonnetPrompt = `${systemPrompt}
${userInstructionsBlock}
${memoryBlock}

Sei un ESPERTO FISCALE ITALIANO chiamato per riclassificare righe complesse che Haiku non ha gestito con sufficiente confidenza.

=== TENTATIVO HAIKU (da rivedere) ===
${haikuAttempts}
===

ARTICOLI:
${artSection}
CATEGORIE:
${catSection}

CONTI (COMPLETI):
${accSection}

CDC:
${cdcSection}

=== CONTROPARTE ===
${counterpartyInfo}
===

=== VINCOLO DIREZIONE (${direction === "in" ? "PASSIVA" : "ATTIVA"}) ===
${direction === "in" ? "Conti di COSTO. VIETATO: conti revenue." : "Conti di RICAVO. VIETATO: conti costo."}
===
${invoiceNotes ? `\n=== NOTE UTENTE SULLA FATTURA ===\n${invoiceNotes}\nQueste note sono dell'utente e hanno PRIORITÀ MASSIMA sulla classificazione.\n===\n` : ""}
REGOLE ESCALATION:
- Riclassifica SOLO le righe [DA RICLASSIFICARE].
- Analizza APPROFONDITAMENTE la fiscalità: ritenuta d'acconto (aliquota, base imponibile), reverse charge, split payment, beni strumentali (ammortamento), deducibilità %, IVA detraibilità %.
- Se il tentativo Haiku era corretto, CONFERMALO con confidence più alta.
- Se era sbagliato, CORREGGILO con reasoning dettagliato.
- fiscal_flags OBBLIGATORI e dettagliati per ogni riga.

RIGHE FATTURA (contesto completo):
${lineContext}

JSON array (no markdown, SOLO righe [DA RICLASSIFICARE]):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"confidence":0-100,"reasoning":"dettagliato","fiscal_flags":{"ritenuta_acconto":{"aliquota":20,"base":"100%"}|null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]`;

  console.log(`[sonnet-escalate] Escalating ${escalationLines.length} lines to Sonnet, prompt=${sonnetPrompt.length} chars`);

  try {
    // Note: Extended Thinking requires system prompt in user message (API requirement)
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_SONNET,
        max_tokens: 16000,
        thinking: { type: "enabled" as const, budget_tokens: SONNET_THINKING_BUDGET },
        messages: [{ role: "user" as const, content: sonnetPrompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `Sonnet escalation API ${resp.status}: ${errText.slice(0, 300)}`;
      console.error(`[sonnet-escalate] ${msg}`);
      return { lineResults: [], error: msg };
    }

    const data = await resp.json();
    const contentBlocks = (data as any)?.content || [];

    // Log thinking
    const thinkingBlock = contentBlocks.find((b: any) => b.type === "thinking");
    if (thinkingBlock) {
      console.log(`[sonnet-escalate] Thinking: ${(thinkingBlock.thinking || "").slice(0, 200)}...`);
    }

    // Extract text
    const text = contentBlocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

    const stopReason = (data as any)?.stop_reason;
    console.log(`[sonnet-escalate] Response: ${text.length} chars, stop=${stopReason}`);

    if (!text) {
      return { lineResults: [], error: "Sonnet returned empty text" };
    }

    // Parse JSON
    let classJson = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let jsonStr = extractFirstJsonArray(classJson);

    if (!jsonStr) {
      const msg = `Sonnet escalation: no JSON array. First 300: ${classJson.slice(0, 300)}`;
      console.warn(`[sonnet-escalate] ${msg}`);
      return { lineResults: [], error: msg };
    }

    const parsed: SonnetLineResult[] = JSON.parse(jsonStr);
    console.log(`[sonnet-escalate] Parsed ${parsed.length} lines from Sonnet`);
    return { lineResults: parsed };
  } catch (e) {
    const msg = `Sonnet escalation error: ${e}`;
    console.error(`[sonnet-escalate] ${msg}`);
    return { lineResults: [], error: msg };
  }
}

/* ─── Extract first balanced JSON array from text ──── */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced — try partial recovery (truncated output)
  return null;
}

/* ─── Classify a single batch of lines ──── */

async function classifyBatch(
  batchLines: InputLine[],
  batchIndex: number,
  totalBatches: number,
  apiKey: string,
  buildPromptForBatch: (lines: InputLine[]) => string,
): Promise<{ lineResults: SonnetLineResult[]; keywords: string[]; error?: string }> {
  const batchThinkingBudget = Math.min(
    MAX_THINKING_BUDGET,
    Math.max(MIN_THINKING_BUDGET, batchLines.length * THINKING_PER_LINE),
  );

  const prompt = buildPromptForBatch(batchLines);

  console.log(
    `[classify] Batch ${batchIndex + 1}/${totalBatches}: ${batchLines.length} lines, thinking=${batchThinkingBudget}, prompt=${prompt.length} chars`,
  );

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 16000,
        thinking: { type: "enabled" as const, budget_tokens: batchThinkingBudget },
        messages: [{ role: "user" as const, content: prompt }],
      }),
    });
  } catch (fetchErr) {
    const msg = `Batch ${batchIndex + 1} fetch error: ${fetchErr}`;
    console.error(`[classify] ${msg}`);
    return { lineResults: [], keywords: [], error: msg };
  }

  if (!resp.ok) {
    const errText = await resp.text();
    const msg = `Batch ${batchIndex + 1} API ${resp.status}: ${errText.slice(0, 300)}`;
    console.error(`[classify] ${msg}`);
    return { lineResults: [], keywords: [], error: msg };
  }

  const data = await resp.json();
  const contentBlocks = (data as any)?.content || [];

  // Log response structure
  console.log(`[classify] Batch ${batchIndex + 1} blocks:`, contentBlocks.map((b: any) => ({
    type: b.type,
    len: (b.text || b.thinking || '').length,
  })));

  // Log thinking for debug (truncated)
  const thinkingBlock = contentBlocks.find((b: any) => b.type === "thinking");
  if (thinkingBlock) {
    console.log(
      `[classify] Batch ${batchIndex + 1} thinking: ${(thinkingBlock.thinking || "").slice(0, 150)}...`,
    );
  }

  // Extract text
  const textBlocks = contentBlocks.filter((b: any) => b.type === "text");
  const text = textBlocks.map((b: any) => b.text).join("") || "";
  const stopReason = (data as any)?.stop_reason;
  console.log(
    `[classify] Batch ${batchIndex + 1} response: ${text.length} chars, stop=${stopReason}`,
  );

  // Safety: if no text blocks, log warning
  if (!text) {
    const msg = `Batch ${batchIndex + 1}: empty text response. Blocks: ${JSON.stringify(contentBlocks.map((b: any) => b.type))}. stop=${stopReason}`;
    console.error(`[classify] ${msg}`);
    return { lineResults: [], keywords: [], error: msg };
  }

  // Parse keywords
  let keywords: string[] = [];
  const keywordsSplit = text.split("---KEYWORDS---");
  let classJson = keywordsSplit[0].trim();
  if (keywordsSplit.length > 1) {
    try {
      let kwSection = keywordsSplit[1];
      kwSection = kwSection
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const kwMatch = kwSection.match(/\[\s*[\s\S]*?\]/);
      if (kwMatch) keywords = JSON.parse(kwMatch[0]);
    } catch {
      /* ignore */
    }
  }

  // Parse classification JSON (with backtick stripping + bracket-counting extraction)
  try {
    classJson = classJson
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    // Use bracket-counting to extract first complete JSON array
    // (avoids greedy regex matching past the array into keywords/notes)
    let jsonStr = extractFirstJsonArray(classJson);

    // Partial JSON recovery if truncated (no balanced array found)
    if (!jsonStr && stopReason === "max_tokens") {
      console.warn(
        `[classify] Batch ${batchIndex + 1}: truncated output, attempting partial recovery...`,
      );
      const arrayStart = classJson.indexOf("[");
      if (arrayStart >= 0) {
        let partial = classJson.slice(arrayStart);
        const lastCompleteObj = partial.lastIndexOf("},");
        if (lastCompleteObj > 0) {
          jsonStr = partial.slice(0, lastCompleteObj + 1) + "]";
        } else {
          const singleObj = partial.lastIndexOf("}");
          if (singleObj > 0) {
            jsonStr = partial.slice(0, singleObj + 1) + "]";
          }
        }
        if (jsonStr)
          console.log(
            `[classify] Batch ${batchIndex + 1}: partial recovery succeeded`,
          );
      }
    }

    if (!jsonStr) {
      const msg = `Batch ${batchIndex + 1}: no JSON array. First 300 chars: ${classJson.slice(0, 300)}`;
      console.warn(`[classify] ${msg}`);
      return { lineResults: [], keywords, error: msg };
    }
    const parsed: SonnetLineResult[] = JSON.parse(jsonStr);
    console.log(`[classify] Batch ${batchIndex + 1}: parsed ${parsed.length} lines OK`);
    return { lineResults: parsed, keywords };
  } catch (e) {
    const msg = `Batch ${batchIndex + 1} parse error: ${e}. First 300: ${classJson.slice(0, 300)}`;
    console.error(`[classify] ${msg}`);
    return { lineResults: [], keywords, error: msg };
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
    let counterpartyAtecoFull = "";  // For embedding enrichment
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
            // Save for embedding query enrichment
            counterpartyAtecoFull = `${atecoRow.ateco_code} ${atecoRow.ateco_description || ""}`.trim();
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

    // ─── Invoice notes (user annotations for classification hints) ──
    const [invoiceRow] = await sql`SELECT notes FROM invoices WHERE id = ${invoiceId} LIMIT 1`;
    const invoiceNotes = (invoiceRow?.notes || "").trim();
    if (invoiceNotes) console.log(`[classify] Invoice notes: "${invoiceNotes.slice(0, 80)}…"`);

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
        counterpartyAtecoFull || undefined,
        invoiceNotes || undefined,
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

    // ─── Stage 2: Haiku Classification (with context-aware batching) ──────────

    // Build prompt function — for batching, ALL lines are sent but only a subset
    // is marked [DA CLASSIFICARE]. This preserves context (e.g., "cantiere Via X"
    // in batch 1 helps classify materials in batch 2).
    const buildBatchPromptWithContext = (batchLineIds: Set<string>) =>
      buildFocusedPrompt(
        preflightArticles,
        preflightCategories,
        preflightAccounts,
        preflightProjects,
        phases,
        counterpartyInfo,
        history,
        memoryBlock,
        direction,
        inputLines,     // ALL lines always
        systemPrompt,
        userInstructionsBlock,
        batchLineIds,   // which ones to classify
        invoiceNotes || undefined,
      );

    // For small invoices (no batching), no context markers needed
    const buildSinglePrompt = (lines: InputLine[]) =>
      buildFocusedPrompt(
        preflightArticles,
        preflightCategories,
        preflightAccounts,
        preflightProjects,
        phases,
        counterpartyInfo,
        history,
        memoryBlock,
        direction,
        lines,
        systemPrompt,
        userInstructionsBlock,
        undefined,      // no batch filter
        invoiceNotes || undefined,
      );

    let allLineResults: SonnetLineResult[] = [];
    let allKeywords: string[] = [];
    let thinkingUsed = false;
    const batchErrors: string[] = [];
    const totalBatches = Math.ceil(inputLines.length / MAX_LINES_PER_BATCH);

    console.log(
      `[classify-invoice-lines] Calling Haiku for ${inputLines.length} lines → ${totalBatches} batch(es), invoice=${invoiceId}, cp=${counterpartyName}`,
    );

    if (inputLines.length <= MAX_LINES_PER_BATCH) {
      // Small invoice: single call, no context markers
      const result = await classifyBatch(
        inputLines,
        0,
        1,
        apiKey,
        buildSinglePrompt,
      );
      allLineResults = result.lineResults;
      allKeywords = result.keywords;
      if (result.error) batchErrors.push(result.error);
      thinkingUsed = true;
    } else {
      // Large invoice: split line IDs into batches, each batch sees ALL lines with context markers
      const lineIdBatches: string[][] = [];
      for (let i = 0; i < inputLines.length; i += MAX_LINES_PER_BATCH) {
        lineIdBatches.push(
          inputLines.slice(i, i + MAX_LINES_PER_BATCH).map(l => l.line_id)
        );
      }

      console.log(
        `[classify] Large invoice: ${inputLines.length} lines → ${lineIdBatches.length} batches of max ${MAX_LINES_PER_BATCH} (context-aware: all lines sent per batch)`,
      );

      // Run batches in parallel (max MAX_PARALLEL_BATCHES concurrently)
      for (let i = 0; i < lineIdBatches.length; i += MAX_PARALLEL_BATCHES) {
        const parallelBatchIds = lineIdBatches.slice(i, i + MAX_PARALLEL_BATCHES);
        const results = await Promise.all(
          parallelBatchIds.map((batchIds, j) => {
            const batchIdSet = new Set(batchIds);
            // Only the batch lines count for thinking budget
            const batchLines = inputLines.filter(l => batchIdSet.has(l.line_id));
            return classifyBatch(
              batchLines,
              i + j,
              lineIdBatches.length,
              apiKey,
              () => buildBatchPromptWithContext(batchIdSet),
            );
          }),
        );
        for (const r of results) {
          allLineResults.push(...r.lineResults);
          allKeywords.push(...r.keywords);
          if (r.error) batchErrors.push(r.error);
        }
      }

      // Deduplicate keywords
      allKeywords = [...new Set(allKeywords)].slice(0, 10);
      thinkingUsed = true;
    }

    // Log batch errors summary
    if (batchErrors.length > 0) {
      console.error(`[classify] ${batchErrors.length}/${totalBatches} batch(es) failed:`, batchErrors);
    }

    // Normalize results
    let lineResults: SonnetLineResult[] = allLineResults.map((item) => ({
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

    let keywords = allKeywords;

    console.log(
      `[classify-invoice-lines] ${lineResults.length} lines classified by Haiku+Thinking (${totalBatches} batch${totalBatches > 1 ? "es" : ""})`,
    );

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

    // ─── Stage 3: Sonnet Escalation for fiscal-complex lines ──────────
    // After Haiku classification + direction enforcement, check for lines that
    // need expert fiscal review (ritenuta, reverse charge, beni strumentali,
    // suggest_new_account, or low confidence).
    let sonnetEscalatedCount = 0;
    {
      const escalationCandidates = lineResults.filter(lr => needsSonnetEscalation(lr));

      if (escalationCandidates.length > 0) {
        console.log(
          `[classify] Sonnet escalation: ${escalationCandidates.length}/${lineResults.length} lines need expert review:`,
          escalationCandidates.map(lr => ({
            line_id: lr.line_id,
            confidence: lr.confidence,
            ritenuta: !!lr.fiscal_flags?.ritenuta_acconto,
            reverse_charge: !!lr.fiscal_flags?.reverse_charge,
            bene_strumentale: !!lr.fiscal_flags?.bene_strumentale,
            suggest_new: !!lr.suggest_new_account,
          })),
        );

        const sonnetResult = await sonnetEscalate(
          escalationCandidates,
          inputLines,
          allAccounts,     // full account list for Sonnet
          allCategories,   // full category list for Sonnet
          projects,        // all projects
          articles,
          phases,
          counterpartyInfo,
          history,
          memoryBlock,
          direction,
          systemPrompt,
          userInstructionsBlock,
          apiKey,
          invoiceNotes || undefined,
        );

        if (sonnetResult.error) {
          console.warn(`[classify] Sonnet escalation failed: ${sonnetResult.error} — keeping Haiku results`);
        } else if (sonnetResult.lineResults.length > 0) {
          // Merge: replace Haiku results with Sonnet results for escalated lines
          const sonnetMap = new Map(sonnetResult.lineResults.map(lr => [lr.line_id, lr]));
          let upgraded = 0;
          for (let i = 0; i < lineResults.length; i++) {
            const sonnetLr = sonnetMap.get(lineResults[i].line_id);
            if (sonnetLr) {
              // Normalize Sonnet result
              const merged: SonnetLineResult = {
                line_id: sonnetLr.line_id,
                article_code: sonnetLr.article_code || lineResults[i].article_code,
                phase_code: sonnetLr.phase_code || lineResults[i].phase_code,
                category_id: sonnetLr.category_id || lineResults[i].category_id,
                category_name: sonnetLr.category_name || lineResults[i].category_name,
                account_id: sonnetLr.account_id || lineResults[i].account_id,
                account_code: sonnetLr.account_code || lineResults[i].account_code,
                cost_center_allocations: sonnetLr.cost_center_allocations || lineResults[i].cost_center_allocations,
                confidence: Math.min(Math.max(Number(sonnetLr.confidence) || 50, 0), 100),
                reasoning: `[SONNET] ${sonnetLr.reasoning || lineResults[i].reasoning}`,
                fiscal_flags: sonnetLr.fiscal_flags || lineResults[i].fiscal_flags,
                suggest_new_account: sonnetLr.suggest_new_account || null,
                suggest_new_category: sonnetLr.suggest_new_category || null,
              };
              lineResults[i] = merged;
              upgraded++;
            }
          }
          sonnetEscalatedCount = upgraded;
          console.log(`[classify] Sonnet escalation: ${upgraded} lines upgraded, ${sonnetResult.lineResults.length} returned`);
        }
      } else {
        console.log(`[classify] No lines need Sonnet escalation`);
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
        thinking_enabled: thinkingUsed,
        batches: totalBatches,
        ...(sonnetEscalatedCount > 0 ? {
          sonnet_escalated: sonnetEscalatedCount,
          sonnet_model: MODEL_SONNET,
        } : {}),
        ...(batchErrors.length > 0 ? { batch_errors: batchErrors } : {}),
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
