// classify-invoice-lines — Single Gemini 3.1 Pro agent for invoice classification + fiscal review
// Stage 1: Embedding pre-flight (Gemini) → Stage 2: Gemini 3.1 Pro (classification + fiscal flags)
// RAG: fiscal_knowledge table for normative context.
//
// PRINCIPLE: produces SUGGESTIONS only (classification_status = 'ai_suggested'
// on invoices table). NEVER 'confirmed'. User must always confirm.

import postgres from "npm:postgres@3.4.5";
import {
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
const GEMINI_MODEL = "gemini-3.1-pro-preview";
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
    // Also allowed: financial (72xxx proventi), extraordinary, assets/liabilities
    // for art. 15 advances, deposits, prepayments, accruals
    allowed: ["revenue", "financial", "extraordinary", "assets", "liabilities"],
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

interface FiscalAlertOption {
  label: string;
  fiscal_override: Partial<FiscalFlags>;
  is_default: boolean;
}

interface FiscalAlert {
  type: 'deducibilita' | 'ritenuta' | 'reverse_charge' | 'split_payment' | 'bene_strumentale' | 'iva_indetraibile' | 'general';
  severity: 'warning' | 'info';
  title: string;
  description: string;
  current_choice: string;
  options: FiscalAlertOption[];
  affected_lines: string[];
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

interface FiscalKBRule {
  id: string;
  title: string;
  content: string;
  category: string;
  normativa: string[];
  fiscal_values: Record<string, unknown> | null;
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

/* ─── Fiscal Knowledge Base RAG ──────────── */

async function searchFiscalKB(
  sql: SqlClient,
  queryVec: number[],
  counterpartyAteco: string,
  counterpartyType: string,
  accountCodes: string[],
): Promise<FiscalKBRule[]> {
  try {
    const vecLiteral = toVectorLiteral(queryVec);
    const atecoPrefix = counterpartyAteco ? counterpartyAteco.slice(0, 2) : "";
    const accPrefixes = accountCodes.map(c => c.slice(0, 3));

    // Semantic + keyword search on fiscal_knowledge
    const rows = await sql.unsafe(
      `SELECT id, title, content, category, normativa, fiscal_values,
              (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
       FROM fiscal_knowledge
       WHERE active = true AND embedding IS NOT NULL
         AND (
           (1 - (embedding <=> $1::halfvec(3072))) >= 0.35
           OR ($2 != '' AND $2 = ANY(trigger_ateco_prefixes))
           OR ($3 != '' AND $3 = ANY(trigger_counterparty_types))
           OR (trigger_account_prefixes && $4::text[])
         )
       ORDER BY
         CASE WHEN ($2 != '' AND $2 = ANY(trigger_ateco_prefixes)) THEN 0 ELSE 1 END,
         priority DESC,
         embedding <=> $1::halfvec(3072)
       LIMIT 8`,
      [vecLiteral, atecoPrefix, counterpartyType, accPrefixes],
    );

    const rules = (rows as FiscalKBRule[]).map(r => ({
      id: r.id,
      title: r.title,
      content: r.content,
      category: r.category,
      normativa: r.normativa || [],
      fiscal_values: r.fiscal_values,
    }));

    console.log(`[fiscal-kb] Found ${rules.length} relevant fiscal rules`);
    return rules;
  } catch (err) {
    console.warn("[fiscal-kb] Search failed:", err);
    return [];
  }
}

/* ─── Build Gemini prompt (classification + fiscal) ─── */

function buildGeminiPrompt(
  articles: ArticleRow[],
  categories: CategoryRow[],
  accounts: AccountRow[],
  projects: ProjectRow[],
  phases: ArticlePhaseRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  articleHistory: Array<{ description: string; article_code: string; article_name: string; phase_code: string | null; phase_name: string | null; count: number }>,
  memoryBlock: string,
  direction: string,
  lines: InputLine[],
  userInstructionsBlock: string,
  kbRules: FiscalKBRule[],
  company: CompanyContext | undefined,
  invoiceNotes?: string,
): string {
  // Build phases-by-article map
  const phasesByArticle = new Map<string, ArticlePhaseRow[]>();
  for (const p of phases) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, []);
    phasesByArticle.get(p.article_id)!.push(p);
  }

  // Articles section — with phases
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

  // History (limited to 20)
  const historyLimited = history.slice(0, 20);
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

  // Article assignment patterns (cross-counterparty)
  let articleHistorySection = "";
  if (articleHistory.length > 0) {
    const artHistLines = articleHistory.map(ah => {
      const phasePart = ah.phase_code ? ` fase:${ah.phase_code} (${ah.phase_name})` : "";
      return `- "${ah.description}" \u2192 art:${ah.article_code} (${ah.article_name})${phasePart} [${ah.count}x confermato]`;
    });
    articleHistorySection = `\nSTORICO ARTICOLI (pattern confermati da TUTTE le controparti, non solo questa):\n${artHistLines.join("\n")}\nREGOLA ARTICOLI: Se la descrizione di una riga corrisponde o \u00e8 molto simile a uno di questi pattern confermati, SUGGERISCI lo stesso article_code e phase_code. Il numero tra parentesi indica quante volte \u00e8 stato confermato \u2014 pi\u00f9 \u00e8 alto, pi\u00f9 \u00e8 affidabile. Se la descrizione non corrisponde a nessun pattern, lascia article_code=null.`;
  }

  // Fiscal KB rules
  let kbSection = "";
  if (kbRules.length > 0) {
    kbSection = `\n=== NORMATIVA FISCALE RILEVANTE (dalla Knowledge Base) ===\n`;
    kbSection += kbRules.map(r => {
      let entry = `[${r.category}] ${r.title}\n${r.content}`;
      if (r.normativa?.length) entry += `\nRif: ${r.normativa.join(", ")}`;
      if (r.fiscal_values) entry += `\nValori: ${JSON.stringify(r.fiscal_values)}`;
      return entry;
    }).join("\n---\n");
    kbSection += `\n===\n`;
  }

  // Lines
  const lineEntries = lines
    .map((l, i) =>
      `${i + 1}. [${l.line_id}] "${l.description || "N/D"}" qty=${l.quantity ?? "N/D"} tot=${l.total_price ?? "N/D"}`
    )
    .join("\n");

  // Company context
  const companySection = company
    ? `AZIENDA: ${company.company_name}${company.vat_number ? ` (P.IVA: ${company.vat_number})` : ""}${company.sector ? ` — Settore: ${company.sector}` : ""}`
    : "";

  return `Sei un contabile italiano esperto con 20 anni di esperienza nella gestione contabile di PMI italiane. Sei aggiornato sulle normative italiane vigenti (OIC, TUIR, DPR 633/72, Codice Civile).

${companySection}
${userInstructionsBlock}
${memoryBlock}
${kbSection}

COMPETENZE FONDAMENTALI:

1. PARTITA DOPPIA E PIANO DEI CONTI
- Ogni operazione ha DARE e AVERE bilanciati
- Piano dei conti strutturato: patrimoniale (attivo/passivo) + economico (costi/ricavi)

2. IVA (DPR 633/72)
- Aliquote: 22% (ordinaria), 10% (ridotta), 4% (minima), esente (art. 10)
- Reverse charge (art. 17 c.6): fatture edili tra imprese, subappalti
- Split payment (art. 17-ter): fatture verso PA
- IVA indetraibile parziale: auto 40%, telefonia 50%, rappresentanza variabile

3. DEDUCIBILITÀ COSTI (TUIR)
- Auto aziendali NON da trasporto: costo 20%, IVA 40%
- Auto da trasporto (camion, escavatori, mezzi specifici): 100%/100%
- Telefonia: costo 80%, IVA 50%
- Ristorazione/pernottamenti: costo 75%, IVA 100%
- Omaggi: deducibili fino a 50€ unitari

4. RITENUTA D'ACCONTO
- Professionisti (ATECO 69.xx/71.xx/74.xx): ritenuta 20% sull'imponibile
- SRL/SPA: MAI ritenuta (anche se professionista)
- Il committente trattiene 20% e versa con F24

5. BENI STRUMENTALI E AMMORTAMENTO
- Beni > 516,46€ con utilità pluriennale → immobilizzazioni
- Beni ≤ 516,46€ → costo d'esercizio immediato
- SOLO acquisti di beni FISICI DUREVOLI (macchinari, attrezzature, veicoli, computer, mobili)
- NON sono beni strumentali (anche se superano 516€): canoni leasing, manodopera, servizi, materiali di consumo, spese bancarie, affitti, utenze, trasporti, noleggi

6. LEASING
- Canoni leasing HANNO fattura, vanno in conti dedicati per canoni e interessi
- Un canone di locazione finanziaria NON È un bene strumentale — è un costo ricorrente

7. TRASPORTI — DISTINZIONE CRITICA
- Su acquisti: il fornitore porta merce → conto trasporti su acquisti
- Su vendite: noi portiamo merce → conto trasporti su vendite
- Generici → conto trasporti generici

8. NOTE DI CREDITO (TD04)
- Stornano il conto originale con importo negativo
- Stessa categoria e conto della fattura originale

9. AUTOFATTURE (TD16-TD19)
- Reverse charge interno: impostare reverse_charge=true

10. SUGGERIMENTO NUOVI CONTI
- Se il miglior conto è troppo generico, aggiungi suggest_new_account
- ANCHE con suggerimento, assegna SEMPRE il miglior conto ESISTENTE come fallback
- Suggerisci solo quando c'è un VERO gap

${artSection ? `ARTICOLI:\n${artSection}\n` : ""}CATEGORIE:
${catSection}

CONTI:
${accSection}

CDC:
${cdcSection}

=== CONTROPARTE FORNITORE/CLIENTE ===
${counterpartyInfo}
REGOLA: Il NOME della controparte spesso rivela la sua attività principale. Usa il nome come indizio forte.
===

${historySection}
${articleHistorySection}

=== VINCOLO DIREZIONE (${direction === "in" ? "PASSIVA" : "ATTIVA"}) ===
${direction === "in" ? "Conti di COSTO. category.type: expense/both. VIETATO: conti revenue." : "Conti di RICAVO. category.type: revenue/both. VIETATO: conti costo."}
===
${invoiceNotes ? `\n=== NOTE UTENTE SULLA FATTURA ===\n${invoiceNotes}\nQueste note hanno PRIORITÀ MASSIMA sulla classificazione.\n===\n` : ""}
REGOLE CLASSIFICAZIONE:
- Usa storico SOLO se la descrizione corrisponde.
- article_code + phase_code solo se il materiale/prodotto corrisponde.
- category_id e account_id: assegna SEMPRE (UUID esatti dalla lista sopra).
- Coerenza: trasporto→conti trasporto, noleggio→conti noleggio.
- confidence 0-100. Se dubbio, confidence bassa.
- Righe con importo zero (tot=0): sono INFORMATIVE/CONTESTO. Per la riga zero: confidence 30-50, reasoning "Riga informativa/contesto".
- Se NESSUNA categoria corrisponde bene, scegli la più vicina con confidence bassa (50-65).
- CdC: assegna SOLO con segnale chiaro. Se non sei sicuro, lascia vuoto.

REGOLE FISCALI (per OGNI riga):
- deducibilita_pct e iva_detraibilita_pct: determina per ogni riga secondo TUIR/DPR 633
- Coerenza: tutte le righe della stessa fattura per lo stesso mezzo/operazione → STESSE percentuali
- Se hai dubbi, usa la percentuale PIÙ BASSA (conservativa) e scrivi "Verificare: [motivo]" nella nota
- ritenuta_acconto: solo per professionisti (verifica ATECO)
- bene_strumentale: solo beni FISICI DUREVOLI > 516,46€ — MAI canoni, servizi, materiali

RIGHE:
${lineEntries}

FORMATO OUTPUT (2 sezioni separate):

Sezione 1 — JSON array classificazione (no markdown):
[{"line_id":"uuid","article_code":"CODE"|null,"phase_code":"code"|null,"category_id":"uuid","category_name":"nome","account_id":"uuid","account_code":"codice","cost_center_allocations":[{"project_id":"uuid","percentage":100}],"confidence":0-100,"reasoning":"max 30 parole","fiscal_flags":{"ritenuta_acconto":{"aliquota":20,"base":"imponibile"}|null,"reverse_charge":false,"split_payment":false,"bene_strumentale":false,"deducibilita_pct":100,"iva_detraibilita_pct":100,"note":null},"suggest_new_account":null,"suggest_new_category":null}]

---INVOICE_NOTES---
Array JSON di alert fiscali per l'utente. Genera alert SOLO per dubbi che richiedono decisione umana.
Ogni alert: {"type":"deducibilita"|"ritenuta"|"reverse_charge"|"split_payment"|"bene_strumentale"|"iva_indetraibile"|"general","severity":"warning"|"info","title":"titolo breve","description":"spiegazione per l'utente","current_choice":"scelta conservativa applicata","options":[{"label":"Opzione A","fiscal_override":{...},"is_default":false},{"label":"Opzione B","fiscal_override":{...},"is_default":true}],"affected_lines":["line_id1"]}
Se NON ci sono dubbi fiscali: []

---KEYWORDS---
["kw1","kw2",...] (5-10 keywords per search)`;
}

/* ─── Call Gemini 3.1 Pro ─────────────────── */

async function callGemini(
  apiKey: string,
  prompt: string,
  thinkingLevel: "minimal" | "low" | "medium" | "high" = "high",
): Promise<{ text: string; thinkingText: string; error?: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  console.log(`[gemini] Calling ${GEMINI_MODEL}, prompt=${prompt.length} chars, thinking=${thinkingLevel}`);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 65536,
          thinkingConfig: { thinkingLevel },
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const msg = `Gemini API ${resp.status}: ${errText.slice(0, 300)}`;
      console.error(`[gemini] ${msg}`);
      return { text: "", thinkingText: "", error: msg };
    }

    const data = await resp.json();
    const candidates = (data as any)?.candidates || [];
    if (candidates.length === 0) {
      return { text: "", thinkingText: "", error: "No candidates in Gemini response" };
    }

    const parts = candidates[0]?.content?.parts || [];
    let text = "";
    let thinkingText = "";
    for (const part of parts) {
      if (part.thought) {
        thinkingText += part.text || "";
      } else if (part.text) {
        text += part.text;
      }
    }

    const finishReason = candidates[0]?.finishReason || "unknown";
    console.log(`[gemini] Response: ${text.length} chars, thinking=${thinkingText.length} chars, finish=${finishReason}`);

    if (thinkingText) {
      console.log(`[gemini] Thinking: ${thinkingText.slice(0, 200)}...`);
    }

    return { text, thinkingText };
  } catch (e) {
    const msg = `Gemini fetch error: ${e}`;
    console.error(`[gemini] ${msg}`);
    return { text: "", thinkingText: "", error: msg };
  }
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
  invoiceNotes?: FiscalAlert[],
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

  // Save invoice_notes (fiscal alerts) + set has_fiscal_alerts flag
  const hasAlerts = invoiceNotes && invoiceNotes.length > 0;
  try {
    if (hasAlerts) {
      await sql`
        UPDATE invoice_classifications
        SET invoice_notes = ${JSON.stringify(invoiceNotes)}::jsonb
        WHERE invoice_id = ${invoiceId}`;
      await sql`
        UPDATE invoices
        SET has_fiscal_alerts = true
        WHERE id = ${invoiceId}`;
      console.log(`[persist] Saved ${invoiceNotes!.length} fiscal alerts for invoice ${invoiceId}`);
    } else {
      await sql`
        UPDATE invoices
        SET has_fiscal_alerts = false
        WHERE id = ${invoiceId}`;
    }
  } catch (e: unknown) {
    console.error(`[persist] invoice_notes/has_fiscal_alerts failed:`, (e as Error).message);
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

/* ─── Main handler ──────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!geminiKey)
    return json({ error: "GEMINI_API_KEY non configurata" }, 503);

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
    // ─── Step 1: Load all context in parallel ───────────────────
    const [articles, allCategories, allAccounts, projects, phases] = await Promise.all([
      sql<ArticleRow[]>`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql<CategoryRow[]>`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true ORDER BY sort_order, name`,
      sql<AccountRow[]>`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false ORDER BY code`,
      sql<ProjectRow[]>`SELECT id, code, name FROM projects WHERE company_id = ${companyId} AND status = 'active' ORDER BY code`,
      sql<ArticlePhaseRow[]>`SELECT id, article_id, code, name, phase_type, is_counting_point, invoice_direction FROM article_phases WHERE company_id = ${companyId} AND active = true ORDER BY article_id, sort_order`,
    ]);

    // ─── Step 2: Filter categories and accounts by direction ────
    const dirSections = SECTIONS_FOR_DIRECTION[direction] || SECTIONS_FOR_DIRECTION["in"];
    const allowedCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
    const categories = allCategories.filter((c) => allowedCatTypes.includes(c.type));
    const primaryAccounts = allAccounts.filter((a) => dirSections.primary.includes(a.section));
    const secondaryAccounts = allAccounts.filter(
      (a) => dirSections.allowed.includes(a.section) && !dirSections.primary.includes(a.section),
    );
    console.log(`[classify] direction=${direction}: ${categories.length}/${allCategories.length} cats, ${primaryAccounts.length} primary + ${secondaryAccounts.length} secondary accounts`);

    // ─── Step 3: Counterparty ATECO info ────────────────────────
    let counterpartyInfo = counterpartyName || "N.D.";
    let counterpartyAtecoFull = "";
    let counterpartyLegalType = "";
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
            counterpartyAtecoFull = `${atecoRow.ateco_code} ${atecoRow.ateco_description || ""}`.trim();
          }
          if (atecoRow.business_sector)
            parts.push(`Settore: ${atecoRow.business_sector}`);
          if (atecoRow.legal_type) {
            parts.push(`Tipo: ${atecoRow.legal_type}`);
            counterpartyLegalType = atecoRow.legal_type || "";
          }
          if (atecoRow.address)
            parts.push(`Sede: ${atecoRow.address}`);
          counterpartyInfo += ` — ${parts.join(" — ")}`;
        }
      }
    }

    // ─── Step 4: Invoice notes ──────────────────────────────────
    const [invoiceRow] = await sql`SELECT notes FROM invoices WHERE id = ${invoiceId} LIMIT 1`;
    const invoiceNotes = (invoiceRow?.notes || "").trim();
    if (invoiceNotes) console.log(`[classify] Invoice notes: "${invoiceNotes.slice(0, 80)}…"`);

    // ─── Step 5: Counterparty classification history ────────────
    let history: HistoryRow[] = [];
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey
        .toUpperCase()
        .replace(/^IT/i, "")
        .replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
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
        // Fallback: if sparse history for this direction, supplement
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
            history = [...history, ...allDirHistory];
            console.log(`[classify] Supplemented history: ${history.length - allDirHistory.length} same-dir + ${allDirHistory.length} other-dir entries`);
          }
        }
      }
    }

    // ─── Step 5b: Cross-counterparty article history ────────────
    // Articles are cross-counterparty: "Vendita pozzolana..." appears in invoices
    // from 10+ different counterparties, all classified with POZ-RSS phase VND.
    let articleHistory: Array<{
      description: string;
      article_code: string;
      article_name: string;
      phase_code: string | null;
      phase_name: string | null;
      count: number;
    }> = [];

    try {
      articleHistory = (await sql`
        SELECT il.description,
               art.code as article_code, art.name as article_name,
               ap.code as phase_code, ap.name as phase_name,
               count(*)::int as count
        FROM invoice_line_articles ila
        JOIN articles art ON ila.article_id = art.id
        LEFT JOIN article_phases ap ON ila.phase_id = ap.id
        JOIN invoice_lines il ON ila.invoice_line_id = il.id
        JOIN invoices i ON ila.invoice_id = i.id
        WHERE ila.company_id = ${companyId}
          AND ila.verified = true
          AND i.direction = ${direction}
        GROUP BY il.description, art.code, art.name, ap.code, ap.name
        HAVING count(*) >= 2
        ORDER BY count(*) DESC
        LIMIT 30
      `) as typeof articleHistory;

      if (articleHistory.length > 0) {
        console.log(`[classify] Cross-counterparty article history: ${articleHistory.length} patterns found`);
      }
    } catch (e) {
      console.warn(`[classify] Cross-counterparty article history failed:`, e);
    }

    // ─── Step 6: Load company context + user instructions ───────
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

    const userInstructionsBlock = await getUserInstructionsBlock(sql, companyId);
    if (userInstructionsBlock) {
      console.log(`[classify] Loaded user instructions`);
    }

    // ─── Step 7: Embedding Pre-flight ──────────────────────────
    let preflightAccounts: AccountRow[] = [...primaryAccounts, ...secondaryAccounts];
    let preflightCategories: CategoryRow[] = categories;
    let preflightArticles: ArticleRow[] = articles;
    let preflightProjects: ProjectRow[] = projects;
    let memoryFacts: MemoryFact[] = [];
    let queryVec: number[] | null = null;

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

    if (inputLines.length > 0) {
      const preflight = await embeddingPreflight(
        sql, companyId, inputLines, counterpartyName, counterpartyId,
        direction, geminiKey, dirSections, allowedCatTypes,
        counterpartyAtecoFull || undefined,
        invoiceNotes || undefined,
      );

      if (preflight) {
        queryVec = preflight.queryVec;
        const totalPfResults = preflight.accounts.length + preflight.categories.length + preflight.articles.length;
        if (totalPfResults === 0) {
          console.log(`[classify] ❄ Cold-start: no embeddings found — using full entity lists`);
        } else {
          if (preflight.accounts.length >= 5) {
            preflightAccounts = preflight.accounts;
          } else {
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
        memoryFacts = preflight.memoryFacts;
      }
    }

    // Build memory block for prompt
    const memoryBlock = getCompanyMemoryBlock(memoryFacts);

    // ─── Step 8: Fiscal KB RAG ─────────────────────────────────
    let kbRules: FiscalKBRule[] = [];
    if (queryVec) {
      // Collect account codes from preflight for trigger matching
      const accCodes = preflightAccounts.map(a => a.code);
      kbRules = await searchFiscalKB(
        sql,
        queryVec,
        counterpartyAtecoFull,
        counterpartyLegalType,
        accCodes,
      );
    }

    // ─── Step 9: Single Gemini call (classification + fiscal) ──
    const prompt = buildGeminiPrompt(
      preflightArticles,
      preflightCategories,
      preflightAccounts,
      preflightProjects,
      phases,
      counterpartyInfo,
      history,
      articleHistory,
      memoryBlock,
      direction,
      inputLines,
      userInstructionsBlock,
      kbRules,
      companyContext,
      invoiceNotes || undefined,
    );

    // Thinking level: high for complex invoices, medium for simple ones
    const thinkingLevel = inputLines.length > 10 ? "high" : "medium";

    console.log(
      `[classify] Calling Gemini 3.1 Pro for ${inputLines.length} lines, invoice=${invoiceId}, cp=${counterpartyName}, thinking=${thinkingLevel}`,
    );

    const geminiResult = await callGemini(geminiKey, prompt, thinkingLevel);

    if (geminiResult.error || !geminiResult.text) {
      return json({
        error: geminiResult.error || "Gemini returned empty response",
        invoice_id: invoiceId,
        lines: [],
        invoice_notes: [],
        invoice_level: { category_id: null, account_id: null, project_allocations: [], confidence: 0, reasoning: "Gemini error" },
        keywords: [],
        stats: { total_lines: inputLines.length, classified: 0, model: GEMINI_MODEL, error: geminiResult.error },
      }, 200); // 200 so frontend can still show the error gracefully
    }

    // ─── Parse Gemini output ───────────────────────────────────
    const fullText = geminiResult.text;
    const cleanText = fullText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

    // Split into sections
    const notesSeparator = "---INVOICE_NOTES---";
    const kwSeparator = "---KEYWORDS---";

    let classificationText: string;
    let invoiceNotesText: string | null = null;
    let keywordsText: string | null = null;

    // Find separators
    const notesIdx = cleanText.indexOf(notesSeparator);
    const kwIdx = cleanText.indexOf(kwSeparator);

    if (notesIdx >= 0) {
      classificationText = cleanText.slice(0, notesIdx).trim();
      if (kwIdx >= 0 && kwIdx > notesIdx) {
        invoiceNotesText = cleanText.slice(notesIdx + notesSeparator.length, kwIdx).trim();
        keywordsText = cleanText.slice(kwIdx + kwSeparator.length).trim();
      } else {
        invoiceNotesText = cleanText.slice(notesIdx + notesSeparator.length).trim();
      }
    } else if (kwIdx >= 0) {
      classificationText = cleanText.slice(0, kwIdx).trim();
      keywordsText = cleanText.slice(kwIdx + kwSeparator.length).trim();
    } else {
      classificationText = cleanText;
    }

    // Parse classification JSON
    const jsonStr = extractFirstJsonArray(classificationText);
    if (!jsonStr) {
      console.error(`[classify] No JSON array in Gemini response. First 500: ${classificationText.slice(0, 500)}`);
      return json({
        error: "Gemini response: no JSON array found",
        invoice_id: invoiceId,
        lines: [],
        invoice_notes: [],
        invoice_level: { category_id: null, account_id: null, project_allocations: [], confidence: 0, reasoning: "Parse error" },
        keywords: [],
        stats: { total_lines: inputLines.length, classified: 0, model: GEMINI_MODEL, error: "no_json_array" },
      }, 200);
    }

    const parsed: SonnetLineResult[] = JSON.parse(jsonStr);
    console.log(`[classify] Parsed ${parsed.length} lines from Gemini`);

    // Parse fiscal alerts
    let fiscalAlerts: FiscalAlert[] = [];
    if (invoiceNotesText) {
      try {
        const notesJson = extractFirstJsonArray(invoiceNotesText);
        if (notesJson) {
          fiscalAlerts = JSON.parse(notesJson) as FiscalAlert[];
          console.log(`[classify] Parsed ${fiscalAlerts.length} fiscal alerts`);
        }
      } catch (e) {
        console.warn(`[classify] Failed to parse invoice_notes: ${e}`);
      }
    }

    // Parse keywords
    let keywords: string[] = [];
    if (keywordsText) {
      try {
        const kwMatch = keywordsText.match(/\[\s*[\s\S]*?\]/);
        if (kwMatch) keywords = JSON.parse(kwMatch[0]);
      } catch { /* ignore */ }
    }

    // ─── Normalize results ─────────────────────────────────────
    let lineResults: SonnetLineResult[] = parsed.map((item) => ({
      line_id: item.line_id,
      article_code: item.article_code || null,
      phase_code: item.phase_code || null,
      category_id: item.category_id || null,
      category_name: item.category_name || null,
      account_id: item.account_id || null,
      account_code: item.account_code || null,
      cost_center_allocations: item.cost_center_allocations || [],
      confidence: Math.min(Math.max(Number(item.confidence) || 50, 0), 100),
      reasoning: item.reasoning || "",
      fiscal_flags: item.fiscal_flags || null,
      suggest_new_account: item.suggest_new_account || null,
      suggest_new_category: item.suggest_new_category || null,
    }));

    // ─── Phase validation ─────────────────────────────────────
    for (const lr of lineResults) {
      if (lr.article_code) {
        const article = articles.find((a) => a.code === lr.article_code);
        if (article) {
          const articlePhases = phases.filter((p) => p.article_id === article.id);
          // Article has phases but AI returned no phase → auto-assign default
          if (articlePhases.length > 0 && !lr.phase_code) {
            const sortedPhases = [...articlePhases].sort((a, b) => ((a as any).sort_order ?? 0) - ((b as any).sort_order ?? 0));
            const defaultPhase = sortedPhases.find(p => p.is_counting_point) || sortedPhases[0];
            if (defaultPhase) {
              lr.phase_code = defaultPhase.code;
              console.log(`[classify] Auto-assigned default phase "${defaultPhase.code}" for article ${lr.article_code} on line ${lr.line_id}`);
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

    // ─── Fallback: resolve category/account by name/code when UUID missing ───
    for (const lr of lineResults) {
      if (!lr.category_id || !allCategories.find((c) => c.id === lr.category_id)) {
        if (lr.category_name) {
          const nameLower = lr.category_name.toLowerCase().trim();
          let match = categories.find((c) => c.name.toLowerCase().trim() === nameLower);
          if (!match) match = allCategories.find((c) => c.name.toLowerCase().trim() === nameLower);
          if (match) {
            console.log(`[classify] Fallback category: "${lr.category_name}" → ${match.id}`);
            lr.category_id = match.id;
          }
        }
      }
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
    for (const lr of lineResults) {
      const inputLine = inputLines.find((l) => l.line_id === lr.line_id);
      if (!inputLine) continue;
      const desc = (inputLine.description || "").toLowerCase();

      if (lr.account_id) {
        const acc = allAccounts.find((a) => a.id === lr.account_id);
        if (acc) {
          const accName = acc.name.toLowerCase();
          const descTransport = /trasport|consegn|sped|vettor|carico/.test(desc);
          const accTransport = /trasport|sped|vettor/.test(accName);
          if (descTransport && !accTransport && !/noleggi|leasing|fermo/.test(accName)) {
            console.warn(`[classify-sanity] Line ${lr.line_id}: desc mentions trasporto but account "${acc.code} ${acc.name}" is not trasporto-related. Confidence: ${lr.confidence}`);
          }
          const descRental = /noleggi|nolo|fermo macchina/.test(desc);
          const accRental = /noleggi|nolo/.test(accName);
          if (descRental && !accRental && !/trasport|leasing/.test(accName)) {
            console.warn(`[classify-sanity] Line ${lr.line_id}: desc mentions noleggio but account "${acc.code} ${acc.name}" is not noleggio-related. Confidence: ${lr.confidence}`);
          }
        }
      }

      if (lr.article_code) {
        const art = articles.find((a) => a.code === lr.article_code);
        if (art) {
          const artName = art.name.toLowerCase();
          const descService = /trasport|noleggi|servizi|consulenz|manutenzi|opere|lavori/.test(desc);
          const artService = /trasport|noleggi|servizi|consulenz|manutenzi/.test(artName);
          const artMaterial = /calcar|pozzolan|inert|ghiai|sabbia|pietr/.test(artName);
          if (descService && artMaterial && !artService) {
            console.warn(`[classify-sanity] Auto-correcting line ${lr.line_id}: desc mentions service but article "${lr.article_code} ${art.name}" is a material — removing article`);
            lr.article_code = null;
            lr.phase_code = null;
            lr.confidence = Math.min(lr.confidence, 70);
          }
        }
      }
    }

    // ─── Direction enforcement (hard safety net) ───────────────
    {
      const allowedSections = dirSections.allowed;
      const dirCatTypes = CAT_TYPES_FOR_DIRECTION[direction] || CAT_TYPES_FOR_DIRECTION["in"];
      let directionCorrections = 0;

      for (const lr of lineResults) {
        // Check account section against direction
        if (lr.account_id) {
          const acc = allAccounts.find((a) => a.id === lr.account_id);
          if (acc && !allowedSections.includes(acc.section)) {
            console.warn(`[classify-direction] ⛔ Line ${lr.line_id}: account "${acc.code} ${acc.name}" (section=${acc.section}) is INVALID for direction=${direction} — removing`);
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
            directionCorrections++;
          }
        }

        // Check category type against direction
        if (lr.category_id) {
          const cat = allCategories.find((c) => c.id === lr.category_id);
          if (cat && !dirCatTypes.includes(cat.type)) {
            console.warn(`[classify-direction] ⛔ Line ${lr.line_id}: category "${cat.name}" (type=${cat.type}) is INVALID for direction=${direction} — removing`);
            const fallbackCat = categories.length > 0 ? categories[0] : null;
            if (fallbackCat) {
              lr.category_id = fallbackCat.id;
              lr.category_name = fallbackCat.name;
              console.log(`[classify-direction] → Auto-substituted with category "${fallbackCat.name}"`);
            } else {
              lr.category_id = null;
              lr.category_name = null;
            }
            lr.confidence = Math.min(lr.confidence, 55);
            directionCorrections++;
          }
        }

        // Validate suggest_new_account/category against direction
        if (lr.suggest_new_account) {
          const suggestedSection = lr.suggest_new_account.section || "";
          if (suggestedSection && !allowedSections.includes(suggestedSection)) {
            console.warn(`[classify-direction] Nullifying suggest_new_account: section "${suggestedSection}" is invalid for direction=${direction}`);
            lr.suggest_new_account = null;
          }
        }
        if (lr.suggest_new_category) {
          const suggestedType = lr.suggest_new_category.type || "";
          if (suggestedType && !dirCatTypes.includes(suggestedType)) {
            console.warn(`[classify-direction] Nullifying suggest_new_category: type "${suggestedType}" is invalid for direction=${direction}`);
            lr.suggest_new_category = null;
          }
        }
      }

      if (directionCorrections > 0) {
        console.warn(`[classify-direction] ⚠ Corrected ${directionCorrections} direction violations for invoice ${invoiceId} (direction=${direction})`);
      }
    }

    // ─── Generate fiscal alerts from fiscal_flags.note ─────────
    // If Gemini didn't return ---INVOICE_NOTES--- section, build alerts from per-line notes
    if (fiscalAlerts.length === 0) {
      const noteGroups = new Map<string, { note: string; lineIds: string[]; deducPct: number; ivaPct: number; ff: FiscalFlags }>();
      for (const lr of lineResults) {
        const ff = lr.fiscal_flags;
        if (!ff?.note) continue;
        if (!/verificar|controllare|dubbio|attenzione|incert/i.test(ff.note)) continue;

        const key = ff.note.slice(0, 80).toLowerCase();
        if (noteGroups.has(key)) {
          noteGroups.get(key)!.lineIds.push(lr.line_id);
        } else {
          noteGroups.set(key, {
            note: ff.note,
            lineIds: [lr.line_id],
            deducPct: ff.deducibilita_pct,
            ivaPct: ff.iva_detraibilita_pct,
            ff,
          });
        }
      }

      for (const [, group] of noteGroups) {
        let type: FiscalAlert['type'] = 'general';
        if (/deducibil|auto|mezzo|trasporto/i.test(group.note)) type = 'deducibilita';
        if (/ritenuta/i.test(group.note)) type = 'ritenuta';
        if (/reverse/i.test(group.note)) type = 'reverse_charge';
        if (/strumentale|ammortizz/i.test(group.note)) type = 'bene_strumentale';

        const options: FiscalAlertOption[] = [];
        if (type === 'deducibilita') {
          options.push(
            { label: `Conservativo (${group.deducPct}% deducibile, ${group.ivaPct}% IVA)`, fiscal_override: { deducibilita_pct: group.deducPct, iva_detraibilita_pct: group.ivaPct }, is_default: true },
            { label: 'Mezzo da trasporto (100%/100%)', fiscal_override: { deducibilita_pct: 100, iva_detraibilita_pct: 100 }, is_default: false },
          );
        } else if (type === 'bene_strumentale') {
          options.push(
            { label: "Costo d'esercizio", fiscal_override: { bene_strumentale: false }, is_default: true },
            { label: 'Bene strumentale (ammortamento)', fiscal_override: { bene_strumentale: true }, is_default: false },
          );
        } else if (type === 'ritenuta') {
          options.push(
            { label: "Con ritenuta d'acconto", fiscal_override: { ritenuta_acconto: { aliquota: 20, base: "imponibile" } }, is_default: true },
            { label: 'Senza ritenuta', fiscal_override: { ritenuta_acconto: null }, is_default: false },
          );
        }

        if (options.length > 0) {
          const affectedLines = group.lineIds.length === lineResults.length ? ['all'] : group.lineIds;
          fiscalAlerts.push({
            type,
            severity: 'warning',
            title: type === 'deducibilita' ? 'Deducibilità da verificare' :
                   type === 'bene_strumentale' ? 'Possibile bene strumentale' :
                   type === 'ritenuta' ? "Ritenuta d'acconto" :
                   'Nota fiscale',
            description: group.note,
            current_choice: options.find(o => o.is_default)?.label || options[0].label,
            options,
            affected_lines: affectedLines,
          });
        }
      }

      if (fiscalAlerts.length > 0) {
        console.log(`[classify] Generated ${fiscalAlerts.length} fiscal alerts from per-line notes`);
      }
    }

    // ─── Compose invoice-level ─────────────────────────────────
    const invoiceLevel = composeInvoiceLevel(lineResults, inputLines);

    // ─── Persist to DB ─────────────────────────────────────────
    await persistResults(
      sql,
      companyId,
      invoiceId,
      lineResults,
      invoiceLevel,
      articles,
      phases,
      fiscalAlerts.length > 0 ? fiscalAlerts : undefined,
    );

    // Mark invoice as ai_suggested
    try {
      await sql`
        UPDATE invoices
        SET classification_status = 'ai_suggested'
        WHERE id = ${invoiceId}
          AND classification_status != 'confirmed'`;
    } catch (e: unknown) {
      console.error(`[persist] UPDATE invoices classification_status failed:`, (e as Error).message);
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
      invoice_notes: fiscalAlerts,
      invoice_level: invoiceLevel,
      keywords,
      stats: {
        total_lines: inputLines.length,
        classified: lineResults.filter((r) => r.confidence >= MIN_CONFIDENCE).length,
        history_count: history.length,
        article_history_patterns: articleHistory.length,
        memory_facts_count: memoryFacts.length,
        model: GEMINI_MODEL,
        kb_rules_found: kbRules.length,
        fiscal_alerts: fiscalAlerts.length,
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
