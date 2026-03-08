// classify-invoice-lines — Unified Sonnet classifier for invoice lines
// Replaces both classification-ai-suggest and article-ai-match with a single
// Sonnet call that has full context: articles, categories, CoA, CdC, ATECO,
// counterparty history, RAG examples.
//
// PRINCIPLE: produces SUGGESTIONS only (classification_status = 'ai_suggested'
// on invoices table). NEVER 'confirmed'. User must always confirm.

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-sonnet-4-6";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const MIN_CONFIDENCE = 60;

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
interface HistoryRow {
  description: string;
  category_name: string | null;
  account_code: string | null;
  account_name: string | null;
  article_code: string | null;
  article_name: string | null;
  cost_center_allocations: unknown;
}

interface SonnetLineResult {
  line_id: string;
  article_code: string | null;
  category_id: string | null;
  account_id: string | null;
  cost_center_allocations: { project_id: string; percentage: number }[] | null;
  confidence: number;
  reasoning: string;
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

/* ─── Build Sonnet prompt ───────────────── */

function buildPrompt(
  articles: ArticleRow[],
  categories: CategoryRow[],
  accounts: AccountRow[],
  projects: ProjectRow[],
  counterpartyInfo: string,
  history: HistoryRow[],
  ragExamples: RagExample[],
  direction: string,
  lines: InputLine[],
  userInstructions: { scope: string; instruction: string }[] = [],
): string {
  // Articles section
  const artSection = articles
    .slice(0, 100)
    .map(
      (a) =>
        `- ${a.code}: ${a.name}${a.description ? ` (${a.description.slice(0, 60)})` : ""} [${(a.keywords || []).join(", ")}]`,
    )
    .join("\n");

  // Categories
  const catSection = categories
    .map((c) => `- ${c.id}: ${c.name} (${c.type})`)
    .join("\n");

  // Chart of accounts
  const coaSection = accounts
    .slice(0, 100)
    .map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`)
    .join("\n");

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
      if (h.article_code) parts.push(`art: ${h.article_code} ${h.article_name || ""}`);
      if (h.category_name) parts.push(`cat: ${h.category_name}`);
      if (h.account_code) parts.push(`conto: ${h.account_code} ${h.account_name || ""}`);
      return parts.join(" → ");
    });
    historySection = `STORICO CLASSIFICAZIONI DI QUESTA CONTROPARTE (ultime confermate dall'utente):\n${histLines.join("\n")}\n(Se lo storico è consistente al 80%+, segui lo storico con alta confidence)`;
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

  return `Sei un contabile italiano esperto specializzato nella classificazione di fatture per PMI.

ARTICOLI DISPONIBILI (codice: nome [keywords]):
${artSection}

CATEGORIE DISPONIBILI:
${catSection}

PIANO DEI CONTI:
${coaSection}

CENTRI DI COSTO:
${cdcSection}

CONTROPARTE: ${counterpartyInfo}

${historySection}
${ragSection}
${userInstructions.length > 0 ? `
REGOLE UTENTE (PRIORITÀ ALTA — applica SEMPRE queste regole dell'utente):
${userInstructions.map((ui) => `- [${ui.scope}] ${ui.instruction}`).join("\n")}
` : ""}
REGOLE:
* PASSIVA (acquisto/direction=in): categorie "expense", conti di costo (60xxx-69xxx o come nel piano conti)
* ATTIVA (vendita/direction=out): categorie "revenue", conti di ricavo (70xxx+)
* Se storico controparte è consistente → SEGUILO con confidence 90+
* Se ATECO disponibile → usalo per guidare categoria e conto
* TRASPORTO/TRASPORTI nella descrizione → servizio di trasporto, NON il materiale
* NOLO/NOLEGGIO → è noleggio, non acquisto
* FORNITURA/VENDITA → è il materiale/prodotto
* article_code: assegna SOLO se pertinente, altrimenti null
* category_id e account_id: assegna SEMPRE
* confidence 0-100

FATTURA: ${direction === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}

RIGHE DA CLASSIFICARE:
${lineEntries}

Rispondi con un array JSON (senza markdown):
[{
  "line_id": "uuid",
  "article_code": "CODICE" o null,
  "category_id": "uuid",
  "account_id": "uuid",
  "cost_center_allocations": [{"project_id": "uuid", "percentage": 100}],
  "confidence": 0-100,
  "reasoning": "spiegazione breve max 30 parole"
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
): Promise<void> {
  const codeToId = new Map(articles.map((a) => [a.code, a.id]));
  let persisted = 0;

  for (const lr of lineResults) {
    if (lr.confidence < MIN_CONFIDENCE) continue;

    // Resolve article_code → article_id
    const articleId = lr.article_code ? (codeToId.get(lr.article_code) || null) : null;

    // Save line-level category/account + mark as ai_suggested
    if (lr.category_id || lr.account_id) {
      try {
        await sql`
          UPDATE invoice_lines
          SET category_id = COALESCE(${lr.category_id}, category_id),
              account_id = COALESCE(${lr.account_id}, account_id),
              classification_status = 'ai_suggested'
          WHERE id = ${lr.line_id}
            AND category_id IS NULL AND account_id IS NULL`;
      } catch (e: unknown) {
        console.error(`[persist] line ${lr.line_id} UPDATE invoice_lines failed:`, (e as Error).message);
      }
    }

    // Save article suggestion as unverified
    if (articleId) {
      try {
        await sql`
          INSERT INTO invoice_line_articles
            (company_id, invoice_id, invoice_line_id, article_id, assigned_by, verified, confidence)
          VALUES (${companyId}, ${invoiceId}, ${lr.line_id}, ${articleId}, 'ai_classification', false, ${lr.confidence})
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
    const [articles, categories, accounts, projects] = await Promise.all([
      sql<ArticleRow[]>`SELECT id, code, name, description, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql<CategoryRow[]>`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true ORDER BY sort_order, name`,
      sql<AccountRow[]>`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false ORDER BY code`,
      sql<ProjectRow[]>`SELECT id, code, name FROM projects WHERE company_id = ${companyId} AND status = 'active' ORDER BY code`,
    ]);

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

    // ─── Counterparty classification history ────────────
    let history: HistoryRow[] = [];
    if (counterpartyVatKey) {
      const vatKey = counterpartyVatKey
        .toUpperCase()
        .replace(/^IT/i, "")
        .replace(/[^A-Z0-9]/gi, "");
      if (vatKey) {
        history = (await sql`
          SELECT il.description, c.name as category_name, a.code as account_code, a.name as account_name,
                 art.code as article_code, art.name as article_name, null::jsonb as cost_center_allocations
          FROM invoice_lines il
          JOIN invoices i ON il.invoice_id = i.id
          LEFT JOIN categories c ON il.category_id = c.id
          LEFT JOIN chart_of_accounts a ON il.account_id = a.id
          LEFT JOIN invoice_line_articles ila ON ila.invoice_line_id = il.id
          LEFT JOIN articles art ON ila.article_id = art.id
          WHERE i.company_id = ${companyId}
            AND i.counterparty_id = (
              SELECT id FROM counterparties
              WHERE vat_key = ${vatKey} AND company_id = ${companyId}
              LIMIT 1
            )
            AND i.classification_status = 'confirmed'
            AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
          ORDER BY i.date DESC
          LIMIT 30`) as HistoryRow[];
      }
    }

    // ─── RAG examples ──────────────────────────────────
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
    let ragExamples: RagExample[] = [];
    if (geminiKey && inputLines.length > 0) {
      // Build a query from all line descriptions + counterparty name
      const queryText =
        inputLines
          .map((l) => l.description)
          .filter(Boolean)
          .join(" | ") +
        ` | ${counterpartyName || "N/D"}`;
      ragExamples = await loadRagExamples(sql, companyId, queryText, geminiKey);
      console.log(
        `[classify-invoice-lines] RAG found ${ragExamples.length} examples`,
      );
    }

    // ─── Load user instructions ────────────────────────
    interface UserInstruction { scope: string; instruction: string }
    let userInstructions: UserInstruction[] = [];
    try {
      userInstructions = await sql<UserInstruction[]>`
        SELECT scope, instruction FROM user_instructions
        WHERE company_id = ${companyId} AND active = true
          AND scope IN ('general', 'classification', 'counterparty')
        ORDER BY scope, created_at`;
      if (userInstructions.length > 0) {
        console.log(`[classify-invoice-lines] Loaded ${userInstructions.length} user instructions`);
      }
    } catch (err) {
      console.warn("[classify-invoice-lines] Error loading user instructions:", err);
    }

    // ─── Build prompt and call Sonnet ──────────────────
    const prompt = buildPrompt(
      articles,
      categories,
      accounts,
      projects,
      counterpartyInfo,
      history,
      ragExamples,
      direction,
      inputLines,
      userInstructions,
    );

    console.log(
      `[classify-invoice-lines] Calling Sonnet for ${inputLines.length} lines, invoice=${invoiceId}, cp=${counterpartyName}`,
    );

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16384,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(
        "[classify-invoice-lines] Sonnet API error:",
        response.status,
        errText.slice(0, 300),
      );
      return json(
        {
          error: `Sonnet HTTP ${response.status}: ${errText.slice(0, 200)}`,
        },
        502,
      );
    }

    const data = await response.json();
    const text = (data as any)?.content?.[0]?.text || "";
    console.log(
      `[classify-invoice-lines] Sonnet response length: ${text.length} chars`,
    );

    // ─── Parse response: classifications + keywords ────
    let classificationsJson: string;
    let keywords: string[] = [];

    const keywordsSplit = text.split("---KEYWORDS---");
    classificationsJson = keywordsSplit[0].trim();
    if (keywordsSplit.length > 1) {
      try {
        const kwMatch = keywordsSplit[1].match(/\[[\s\S]*?\]/);
        if (kwMatch) keywords = JSON.parse(kwMatch[0]);
      } catch {
        console.warn("[classify-invoice-lines] Could not parse keywords");
      }
    }

    let parsed: SonnetLineResult[];
    try {
      const jsonMatch = classificationsJson.match(/\[[\s\S]*\]/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error(
        "[classify-invoice-lines] Failed to parse Sonnet response:",
        e,
        classificationsJson.slice(0, 500),
      );
      return json(
        { error: `Parse error: ${classificationsJson.slice(0, 200)}` },
        502,
      );
    }

    // Normalize parsed results
    const lineResults: SonnetLineResult[] = parsed.map((item) => ({
      line_id: item.line_id,
      article_code: item.article_code || null,
      category_id: item.category_id || null,
      account_id: item.account_id || null,
      cost_center_allocations: item.cost_center_allocations || [],
      confidence: Math.min(
        Math.max(Number(item.confidence) || 50, 0),
        100,
      ),
      reasoning: item.reasoning || "",
    }));

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

    return json({
      invoice_id: invoiceId,
      lines: lineResults.map((lr) => ({
        ...lr,
        article_id: lr.article_code
          ? codeToId.get(lr.article_code) || null
          : null,
      })),
      invoice_level: invoiceLevel,
      keywords,
      stats: {
        total_lines: inputLines.length,
        classified: lineResults.filter(
          (r) => r.confidence >= MIN_CONFIDENCE,
        ).length,
        history_count: history.length,
        rag_count: ragExamples.length,
        model: MODEL,
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
