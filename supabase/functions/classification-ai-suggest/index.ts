// classification-ai-suggest — deterministic + Haiku AI classification for invoices
// Pattern: same as reconciliation-generate (postgres npm, CORS, ANTHROPIC_API_KEY)
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HAIKU_MODEL = "claude-3-5-haiku-20241022";
const MAX_INVOICES = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── types ────────────────────────────── */

interface InvoiceLine {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  vat_rate: number;
  category_id: string | null;
  account_id: string | null;
}

interface ArticleRow {
  id: string;
  code: string;
  name: string;
  keywords: string[];
}

interface RuleRow {
  id: string;
  article_id: string;
  pattern: { description_contains?: string[] };
  confidence: number;
}

interface CategoryRow { id: string; name: string; type: string; }
interface AccountRow { id: string; code: string; name: string; section: string; }
interface ProjectRow { id: string; code: string; name: string; }
interface ConfirmedExample { description: string; category_name: string | null; account_code: string | null; account_name: string | null; }

interface LineResult {
  invoice_line_id: string;
  article_id: string | null;
  category_id: string | null;
  account_id: string | null;
  project_allocations: { project_id: string; percentage: number }[];
  match_type: "deterministic" | "ai";
  confidence: number;
  reasoning: string | null;
}

interface InvoiceResult {
  invoice_id: string;
  lines: LineResult[];
  invoice_level: {
    category_id: string | null;
    account_id: string | null;
    project_allocations: { project_id: string; percentage: number }[];
    confidence: number;
    reasoning: string;
  };
}

/* ─── Step 1: Deterministic matching ─── */

async function deterministicMatch(
  sql: SqlClient,
  companyId: string,
  lines: InvoiceLine[],
  counterpartyPiva: string | null,
  articles: ArticleRow[],
  rules: RuleRow[],
): Promise<Map<string, LineResult>> {
  // Load historical classifications for this counterparty (most frequent article → category/account)
  const historicalClassifs = counterpartyPiva
    ? await sql`
        SELECT ila.article_id, il.category_id, il.account_id, COUNT(*)::int as cnt
        FROM invoice_line_articles ila
        JOIN invoice_lines il ON il.id = ila.invoice_line_id
        JOIN invoices i ON i.id = ila.invoice_id
        WHERE ila.company_id = ${companyId}
          AND i.counterparty->>'piva' ILIKE ${"%" + counterpartyPiva + "%"}
          AND ila.verified = true
          AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
        GROUP BY ila.article_id, il.category_id, il.account_id
        ORDER BY cnt DESC
        LIMIT 100`
    : [];

  const results = new Map<string, LineResult>();

  for (const line of lines) {
    // Skip already classified lines
    if (line.category_id || line.account_id) continue;
    const desc = (line.description || "").toUpperCase().trim();
    if (!desc || desc.length < 3) continue;

    let matched = false;

    // Try rules first (highest confidence first)
    for (const rule of rules) {
      const keywords: string[] = rule.pattern?.description_contains || [];
      if (keywords.length === 0) continue;
      const allMatch = keywords.every((kw) => desc.includes(kw.toUpperCase()));
      if (!allMatch) continue;

      const article = articles.find((a) => a.id === rule.article_id);
      if (!article) continue;

      // Look up historical category/account for this article+counterparty
      const hist = historicalClassifs.find(
        (h: any) => h.article_id === rule.article_id,
      );

      results.set(line.id, {
        invoice_line_id: line.id,
        article_id: rule.article_id,
        category_id: hist?.category_id || null,
        account_id: hist?.account_id || null,
        project_allocations: [],
        match_type: "deterministic",
        confidence: Math.min(Number(rule.confidence) * 100, 98),
        reasoning: `Regola: keywords [${keywords.join(", ")}] → ${article.code} ${article.name}`,
      });
      matched = true;
      break;
    }

    if (matched) continue;

    // Fallback: keyword matching against articles
    let bestScore = 0;
    let bestArticle: ArticleRow | null = null;
    let bestMatched: string[] = [];

    for (const art of articles) {
      if (!art.keywords || art.keywords.length === 0) continue;
      const kws = art.keywords.map((k: string) => k.toUpperCase());
      const hits = kws.filter((kw: string) => desc.includes(kw));
      const score = kws.length > 0 ? hits.length / kws.length : 0;
      if (score > bestScore && score >= 0.5) {
        bestScore = score;
        bestArticle = art;
        bestMatched = hits;
      }
    }

    if (bestArticle && bestScore >= 0.7) {
      const hist = historicalClassifs.find(
        (h: any) => h.article_id === bestArticle!.id,
      );
      results.set(line.id, {
        invoice_line_id: line.id,
        article_id: bestArticle.id,
        category_id: hist?.category_id || null,
        account_id: hist?.account_id || null,
        project_allocations: [],
        match_type: "deterministic",
        confidence: Math.round(bestScore * 100),
        reasoning: `Keywords [${bestMatched.join(", ")}] → ${bestArticle.code} ${bestArticle.name}`,
      });
    }
  }

  return results;
}

/* ─── Step 2: AI classification via Haiku ─── */

async function aiClassify(
  unmatchedLines: InvoiceLine[],
  context: {
    articles: ArticleRow[];
    categories: CategoryRow[];
    accounts: AccountRow[];
    projects: ProjectRow[];
    invoiceDirection: string;
    counterpartyName: string;
    confirmedExamples: ConfirmedExample[];
  },
): Promise<Map<string, LineResult>> {
  const results = new Map<string, LineResult>();
  if (unmatchedLines.length === 0) return results;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.warn("ANTHROPIC_API_KEY not set, skipping AI classification");
    return results;
  }

  // Build few-shot examples section (only if we have confirmed examples)
  const examplesSection = context.confirmedExamples.length > 0
    ? `\nESEMPI DI CLASSIFICAZIONI GIA CONFERMATE (impara da questi pattern):
${context.confirmedExamples.map((ex, i) => {
  const parts: string[] = [];
  if (ex.category_name) parts.push(`Cat: ${ex.category_name}`);
  if (ex.account_code && ex.account_name) parts.push(`Conto: ${ex.account_code} ${ex.account_name}`);
  return `${i + 1}. "${ex.description}" → ${parts.join(", ") || "N.D."}`;
}).join("\n")}
`
    : "";

  const prompt = `Sei un contabile italiano esperto. Classifica le seguenti righe fattura.

ARTICOLI DISPONIBILI (codice: nome [keywords]):
${context.articles.slice(0, 50).map((a) => `- ${a.code}: ${a.name} [${(a.keywords || []).join(", ")}]`).join("\n")}

CATEGORIE DISPONIBILI:
${context.categories.map((c) => `- ${c.id}: ${c.name} (${c.type})`).join("\n")}

PIANO DEI CONTI:
${context.accounts.slice(0, 60).map((a) => `- ${a.id}: ${a.code} ${a.name} (${a.section})`).join("\n")}

CENTRI DI COSTO:
${context.projects.map((p) => `- ${p.id}: ${p.code} ${p.name}`).join("\n")}
${examplesSection}
FATTURA: ${context.invoiceDirection === "in" ? "PASSIVA (acquisto)" : "ATTIVA (vendita)"}
CONTROPARTE: ${context.counterpartyName || "N.D."}

RIGHE DA CLASSIFICARE:
${unmatchedLines.map((l, i) => `${i + 1}. [line_id: ${l.id}] "${l.description}" qty=${l.quantity} total=${l.total_price}`).join("\n")}

Per ogni riga, rispondi SOLO con un array JSON valido (senza markdown o commenti):
[
  {
    "line_id": "uuid...",
    "article_id": "uuid..." oppure null,
    "category_id": "uuid..." oppure null,
    "account_id": "uuid..." oppure null,
    "project_allocations": [{"project_id": "uuid...", "percentage": 100}],
    "confidence": 0-100,
    "reasoning": "breve spiegazione"
  }
]

REGOLE:
- Se la fattura e PASSIVA (acquisto): usa categorie tipo "expense" e conti 60xxx
- Se la fattura e ATTIVA (vendita): usa categorie tipo "revenue" e conti 70xxx
- Assegna article_id SOLO se trovi un articolo molto pertinente, altrimenti null
- Assegna category_id e account_id anche senza articolo
- Se una riga e simile a un esempio confermato, usa la stessa classificazione (alta confidence)
- confidence 0-100: piu alto = piu sicuro
- Rispondi SOLO con l'array JSON, niente altro`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Haiku API error:", response.status, errText);
      return results;
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || "";

    // Parse JSON from response (handle potential markdown wrapping)
    let parsed: any[];
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch (e) {
      console.error("Failed to parse Haiku response:", e, text.slice(0, 500));
      return results;
    }

    for (const item of parsed) {
      if (!item.line_id) continue;
      results.set(item.line_id, {
        invoice_line_id: item.line_id,
        article_id: item.article_id || null,
        category_id: item.category_id || null,
        account_id: item.account_id || null,
        project_allocations: item.project_allocations || [],
        match_type: "ai",
        confidence: Math.min(Math.max(Number(item.confidence) || 50, 0), 100),
        reasoning: item.reasoning || null,
      });
    }
  } catch (e) {
    console.error("AI classification error:", e);
  }

  return results;
}

/* ─── Step 3: Compose invoice-level from line results ─── */

function composeInvoiceLevel(
  lineResults: LineResult[],
  lines: InvoiceLine[],
): InvoiceResult["invoice_level"] {
  if (lineResults.length === 0) {
    return { category_id: null, account_id: null, project_allocations: [], confidence: 0, reasoning: "Nessuna riga classificata" };
  }

  // Category: most common (weighted by total_price)
  const catWeights = new Map<string, number>();
  for (const lr of lineResults) {
    if (!lr.category_id) continue;
    const line = lines.find((l) => l.id === lr.invoice_line_id);
    const weight = Math.abs(line?.total_price || 1);
    catWeights.set(lr.category_id, (catWeights.get(lr.category_id) || 0) + weight);
  }
  let bestCat: string | null = null;
  let bestCatW = 0;
  for (const [cat, w] of catWeights) { if (w > bestCatW) { bestCat = cat; bestCatW = w; } }

  // Account: most common (weighted)
  const accWeights = new Map<string, number>();
  for (const lr of lineResults) {
    if (!lr.account_id) continue;
    const line = lines.find((l) => l.id === lr.invoice_line_id);
    const weight = Math.abs(line?.total_price || 1);
    accWeights.set(lr.account_id, (accWeights.get(lr.account_id) || 0) + weight);
  }
  let bestAcc: string | null = null;
  let bestAccW = 0;
  for (const [acc, w] of accWeights) { if (w > bestAccW) { bestAcc = acc; bestAccW = w; } }

  // Projects: aggregate line-level allocations
  const projMap = new Map<string, number>();
  for (const lr of lineResults) {
    for (const pa of lr.project_allocations) {
      projMap.set(pa.project_id, (projMap.get(pa.project_id) || 0) + pa.percentage);
    }
  }
  const totalProjPct = [...projMap.values()].reduce((s, v) => s + v, 0);
  const projectAllocations = [...projMap.entries()].map(([id, pct]) => ({
    project_id: id,
    percentage: totalProjPct > 0 ? Math.round(pct / totalProjPct * 100) : 100,
  }));

  // Confidence: weighted average
  let totalWeight = 0;
  let confSum = 0;
  for (const lr of lineResults) {
    const line = lines.find((l) => l.id === lr.invoice_line_id);
    const w = Math.abs(line?.total_price || 1);
    confSum += lr.confidence * w;
    totalWeight += w;
  }
  const avgConf = totalWeight > 0 ? Math.round(confSum / totalWeight) : 0;

  const detCount = lineResults.filter((r) => r.match_type === "deterministic").length;
  const aiCount = lineResults.filter((r) => r.match_type === "ai").length;

  return {
    category_id: bestCat,
    account_id: bestAcc,
    project_allocations: projectAllocations,
    confidence: avgConf,
    reasoning: `${lineResults.length} righe classificate (${detCount} deterministiche, ${aiCount} AI). Confidenza media: ${avgConf}%.`,
  };
}

/* ─── Persist results ─── */

async function persistResults(
  sql: SqlClient,
  companyId: string,
  invoiceId: string,
  result: InvoiceResult,
): Promise<void> {
  const MIN_CONFIDENCE = 60;

  for (const lr of result.lines) {
    // Save line-level category/account directly on invoice_lines
    if (lr.confidence >= MIN_CONFIDENCE && (lr.category_id || lr.account_id)) {
      await sql`
        UPDATE invoice_lines
        SET category_id = COALESCE(${lr.category_id}, category_id),
            account_id = COALESCE(${lr.account_id}, account_id)
        WHERE id = ${lr.invoice_line_id}
          AND category_id IS NULL AND account_id IS NULL`;
    }

    // Save article suggestion as unverified
    if (lr.article_id && lr.confidence >= MIN_CONFIDENCE) {
      await sql`
        INSERT INTO invoice_line_articles
          (company_id, invoice_id, invoice_line_id, article_id, assigned_by, verified, confidence)
        VALUES (${companyId}, ${invoiceId}, ${lr.invoice_line_id}, ${lr.article_id}, 'ai_classification', false, ${lr.confidence})
        ON CONFLICT (invoice_line_id) DO NOTHING`;
    }

    // Save line-level CdC allocations
    for (const pa of lr.project_allocations) {
      await sql`
        INSERT INTO invoice_line_projects
          (company_id, invoice_id, invoice_line_id, project_id, percentage, assigned_by)
        VALUES (${companyId}, ${invoiceId}, ${lr.invoice_line_id}, ${pa.project_id}, ${pa.percentage}, 'ai_auto')
        ON CONFLICT DO NOTHING`;
    }
  }

  // Save invoice-level classification as unverified suggestion
  const il = result.invoice_level;
  if (il.confidence >= MIN_CONFIDENCE && (il.category_id || il.account_id)) {
    await sql`
      INSERT INTO invoice_classifications
        (company_id, invoice_id, category_id, account_id, assigned_by, verified, ai_confidence, ai_reasoning)
      VALUES (${companyId}, ${invoiceId}, ${il.category_id}, ${il.account_id}, 'ai_auto', false, ${il.confidence}, ${il.reasoning})
      ON CONFLICT (invoice_id) DO NOTHING`;
  }

  // Save invoice-level CdC allocations
  for (const pa of il.project_allocations) {
    await sql`
      INSERT INTO invoice_projects
        (company_id, invoice_id, project_id, percentage, assigned_by)
      VALUES (${companyId}, ${invoiceId}, ${pa.project_id}, ${pa.percentage}, 'ai_auto')
      ON CONFLICT DO NOTHING`;
  }
}

/* ─── Main handler ─── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: { company_id?: string; invoice_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const invoiceIds = body.invoice_ids || [];
  if (invoiceIds.length === 0) return json({ error: "invoice_ids richiesto" }, 400);
  if (invoiceIds.length > MAX_INVOICES) return json({ error: `Max ${MAX_INVOICES} fatture per richiesta` }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Load shared context once
    const [articles, rules, categories, accounts, projects] = await Promise.all([
      sql<ArticleRow[]>`SELECT id, code, name, keywords FROM articles WHERE company_id = ${companyId} AND active = true ORDER BY code`,
      sql<RuleRow[]>`SELECT id, article_id, pattern, confidence::float FROM article_assignment_rules WHERE company_id = ${companyId} AND confidence > 0.5 ORDER BY confidence DESC`,
      sql<CategoryRow[]>`SELECT id, name, type FROM categories WHERE company_id = ${companyId} AND active = true ORDER BY sort_order, name`,
      sql<AccountRow[]>`SELECT id, code, name, section FROM chart_of_accounts WHERE company_id = ${companyId} AND active = true AND is_header = false ORDER BY code`,
      sql<ProjectRow[]>`SELECT id, code, name FROM projects WHERE company_id = ${companyId} AND status = 'active' ORDER BY code`,
    ]);

    const results: InvoiceResult[] = [];
    let totalDeterministic = 0;
    let totalAi = 0;
    let totalFailed = 0;

    for (const invoiceId of invoiceIds) {
      try {
        // Load invoice metadata
        const [invoiceRow] = await sql`
          SELECT id, direction, counterparty
          FROM invoices
          WHERE id = ${invoiceId} AND company_id = ${companyId}`;
        if (!invoiceRow) { totalFailed++; continue; }

        const counterpartyName = (invoiceRow.counterparty as any)?.denom || "";
        const counterpartyPiva = (invoiceRow.counterparty as any)?.piva || null;

        // Load lines
        const lines = await sql<InvoiceLine[]>`
          SELECT id, invoice_id, description, quantity::float, unit_price::float,
                 total_price::float, vat_rate::float, category_id, account_id
          FROM invoice_lines
          WHERE invoice_id = ${invoiceId}
          ORDER BY line_number`;

        if (lines.length === 0) { totalFailed++; continue; }

        // Step 1: Deterministic
        const detResults = await deterministicMatch(sql, companyId, lines, counterpartyPiva, articles, rules);
        totalDeterministic += detResults.size;

        // Step 2: AI for unmatched — load confirmed examples for few-shot learning
        const unmatchedLines = lines.filter((l) => !detResults.has(l.id) && !l.category_id && !l.account_id);

        // Load confirmed classification examples (same counterparty first, then general)
        let confirmedExamples: ConfirmedExample[] = [];
        if (unmatchedLines.length > 0) {
          // First: examples from same counterparty (most relevant)
          const cpExamples = counterpartyPiva ? await sql<ConfirmedExample[]>`
            SELECT DISTINCT ON (il.description)
              il.description, cat.name as category_name, coa.code as account_code, coa.name as account_name
            FROM invoice_lines il
            JOIN invoices i ON i.id = il.invoice_id
            LEFT JOIN categories cat ON cat.id = il.category_id
            LEFT JOIN chart_of_accounts coa ON coa.id = il.account_id
            WHERE i.company_id = ${companyId}
              AND i.id != ${invoiceId}
              AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
              AND i.counterparty->>'piva' ILIKE ${"%" + counterpartyPiva + "%"}
              AND il.description IS NOT NULL AND length(il.description) > 3
            ORDER BY il.description, i.date DESC
            LIMIT 30` : [];

          // Then: general examples from other counterparties (fill up to 50)
          const remaining = 50 - cpExamples.length;
          const generalExamples = remaining > 0 ? await sql<ConfirmedExample[]>`
            SELECT DISTINCT ON (il.description)
              il.description, cat.name as category_name, coa.code as account_code, coa.name as account_name
            FROM invoice_lines il
            JOIN invoices i ON i.id = il.invoice_id
            LEFT JOIN categories cat ON cat.id = il.category_id
            LEFT JOIN chart_of_accounts coa ON coa.id = il.account_id
            WHERE i.company_id = ${companyId}
              AND i.id != ${invoiceId}
              AND (il.category_id IS NOT NULL OR il.account_id IS NOT NULL)
              AND il.description IS NOT NULL AND length(il.description) > 3
              ${counterpartyPiva ? sql`AND (i.counterparty->>'piva' IS NULL OR i.counterparty->>'piva' NOT ILIKE ${"%" + counterpartyPiva + "%"})` : sql``}
            ORDER BY il.description, i.date DESC
            LIMIT ${remaining}` : [];

          confirmedExamples = [...cpExamples, ...generalExamples];
        }

        const aiResults = await aiClassify(unmatchedLines, {
          articles, categories, accounts, projects,
          invoiceDirection: invoiceRow.direction,
          counterpartyName,
          confirmedExamples,
        });
        totalAi += aiResults.size;

        // Merge all line results
        const allLineResults: LineResult[] = [
          ...detResults.values(),
          ...aiResults.values(),
        ];

        // Step 3: Compose invoice-level
        const invoiceLevel = composeInvoiceLevel(allLineResults, lines);

        const result: InvoiceResult = {
          invoice_id: invoiceId,
          lines: allLineResults,
          invoice_level: invoiceLevel,
        };

        // Persist to DB
        await persistResults(sql, companyId, invoiceId, result);
        results.push(result);
      } catch (e) {
        console.error(`Error classifying invoice ${invoiceId}:`, e);
        totalFailed++;
      }
    }

    return json({
      results,
      stats: {
        total: invoiceIds.length,
        deterministic: totalDeterministic,
        ai: totalAi,
        failed: totalFailed,
      },
    });
  } catch (e: any) {
    console.error("Classification error:", e);
    return json({ error: e.message || "Errore interno" }, 500);
  } finally {
    await sql.end();
  }
});
