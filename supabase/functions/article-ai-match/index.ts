// article-ai-match — Haiku Level 3 article matching for ambiguous lines
// Level 2 (RAG): search learning_examples via Gemini embedding before calling Haiku
// Pattern: same as classification-ai-suggest (postgres npm, CORS, ANTHROPIC_API_KEY)
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_LINES = 20;
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const RAG_DIRECT_THRESHOLD = 0.85;  // Use RAG result directly if similarity >= this
const RAG_CONTEXT_THRESHOLD = 0.70; // Add as extra context if similarity >= this

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── types ────────────────────────────── */

interface InputLine {
  line_id: string;
  description: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
  invoice_number: string | null;
  counterparty_name: string | null;
}

interface ArticleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  keywords: string[];
}

interface ConfirmedExample {
  description: string;
  article_code: string;
  article_name: string;
}

interface AiResult {
  line_id: string;
  article_code: string | null;
  confidence: number;
  reasoning: string;
}

/* ─── load articles ────────────────────── */

async function loadArticles(sql: SqlClient, companyId: string): Promise<ArticleRow[]> {
  const rows = await sql`
    SELECT id, code, name, description, unit, keywords
    FROM articles
    WHERE company_id = ${companyId}
      AND active = true
    ORDER BY code
  `;
  return rows as ArticleRow[];
}

/* ─── load confirmed examples ──────────── */

async function loadConfirmedExamples(
  sql: SqlClient,
  companyId: string,
  limit = 50,
): Promise<ConfirmedExample[]> {
  const rows = await sql`
    SELECT
      il.description,
      a.code AS article_code,
      a.name AS article_name
    FROM invoice_line_articles ila
    JOIN invoice_lines il ON il.id = ila.invoice_line_id
    JOIN articles a ON a.id = ila.article_id
    WHERE ila.company_id = ${companyId}
      AND ila.verified = true
      AND il.description IS NOT NULL
      AND il.description != ''
    ORDER BY ila.created_at DESC
    LIMIT ${limit}
  `;
  return rows as ConfirmedExample[];
}

/* ─── build Haiku prompt ──────────────── */

function buildPrompt(
  articles: ArticleRow[],
  examples: ConfirmedExample[],
  lines: InputLine[],
): string {
  // Article catalog
  const artLines = articles.map(
    a => `- ${a.code}: ${a.name}${a.description ? ` (${clip(a.description, 80)})` : ''} [${(a.keywords || []).join(', ')}]`,
  );

  // Confirmed examples
  const exLines = examples.map(
    (ex, i) => `${i + 1}. "${clip(ex.description, 120)}" → ${ex.article_code} (${ex.article_name})`,
  );

  // Lines to classify
  const lineEntries = lines.map(
    (l, i) =>
      `${i + 1}. [line_id: ${l.line_id}] "${clip(l.description, 200)}"` +
      (l.quantity != null ? ` qty=${l.quantity}` : '') +
      (l.unit_price != null ? ` prezzo_unit=${l.unit_price}` : '') +
      (l.total_price != null ? ` totale=${l.total_price}` : '') +
      (l.invoice_number ? ` fatt=${l.invoice_number}` : '') +
      (l.counterparty_name ? ` controparte=${clip(l.counterparty_name, 50)}` : ''),
  );

  return `Sei un esperto contabile italiano specializzato nella classificazione di prodotti e servizi per un'azienda di cave, inerti e trasporti.

Devi assegnare a ogni riga fattura l'ARTICOLO piu appropriato dalla lista. Un articolo rappresenta un prodotto o servizio specifico dell'azienda.

ARTICOLI DISPONIBILI (codice: nome [keywords]):
${artLines.join('\n')}

${examples.length > 0 ? `ESEMPI DI ASSEGNAMENTI GIA CONFERMATI DALL'UTENTE (impara da questi pattern):
${exLines.join('\n')}
` : ''}
REGOLE IMPORTANTI:
- Leggi la FRASE COMPLETA della descrizione, non solo le singole parole
- "Trasporto calcare" o "Trasporti di calcare" NON e uguale a "Calcare": il primo e un SERVIZIO DI TRASPORTO, il secondo e una FORNITURA MATERIALE
- Se la descrizione contiene TRASPORTO/TRASPORTI → cerca un articolo di trasporto, anche se menziona il materiale trasportato
- Se la descrizione contiene FORNITURA/VENDITA → cerca l'articolo del materiale fornito/venduto
- Se la descrizione contiene COLTIVAZIONE/ESTRAZIONE/SCAVO → cerca l'articolo di estrazione/coltivazione
- Se la descrizione contiene NOLO/NOLEGGIO → e un noleggio, non l'articolo del materiale menzionato
- Se la descrizione contiene FRESATURA/SCOPERTURA → cerca l'articolo del lavoro specifico
- Se la descrizione contiene RIMBORSO SPESE ESPLOSIVO → e un servizio esplosivo, non il materiale
- Se nessun articolo corrisponde (es. manutenzione, consulenza, pulizia, ufficio, generico) → metti article_code: null
- Basa la confidence sugli esempi confermati: se hai visto l'utente assegnare righe simili, confidence alta (90+)
- confidence 0-100: 90+ = molto sicuro, 70-89 = probabile, 50-69 = possibile, <50 = incerto
- Il reasoning deve essere BREVE (max 20 parole) e spiegare PERCHE hai scelto quell'articolo

RIGHE DA CLASSIFICARE:
${lineEntries.join('\n')}

Rispondi SOLO con un array JSON valido, senza markdown e senza backtick:
[{"line_id": "uuid", "article_code": "CODICE" oppure null, "confidence": 0-100, "reasoning": "breve spiegazione"}]`;
}

/* ─── Gemini embedding (for RAG Level 2) ── */

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
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
  if (!response.ok) throw new Error(`Gemini error: ${payload?.error?.message || response.status}`);

  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) {
    throw new Error(`Embedding dims: ${values?.length}, expected ${EXPECTED_DIMS}`);
  }
  return values.map((v: unknown) => Number(v));
}

/* ─── RAG matching (Level 2) ──────────── */

interface RagMatch {
  line_id: string;
  article_code: string;
  confidence: number;
  reasoning: string;
}

async function ragMatchLines(
  sql: SqlClient,
  companyId: string,
  lines: InputLine[],
  geminiKey: string,
): Promise<Map<string, RagMatch>> {
  const results = new Map<string, RagMatch>();

  for (const line of lines) {
    if (!line.description || line.description.length < 5) continue;
    try {
      const vec = await callGeminiEmbedding(geminiKey, line.description);
      const vecLiteral = toVectorLiteral(vec);

      const matches = await sql.unsafe(
        `SELECT output_label, metadata, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
         FROM learning_examples
         WHERE company_id = $2
           AND domain = 'article_assignment'
           AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::halfvec(3072)
         LIMIT 3`,
        [vecLiteral, companyId],
      );

      if (matches.length > 0 && matches[0].similarity >= RAG_DIRECT_THRESHOLD) {
        results.set(line.line_id, {
          line_id: line.line_id,
          article_code: matches[0].output_label,
          confidence: Math.round(matches[0].similarity * 100),
          reasoning: `RAG: esempio confermato simile (${(matches[0].similarity * 100).toFixed(0)}%)`,
        });
      }
    } catch (err) {
      // Skip RAG for this line — will fall through to Haiku
      console.warn(`[article-ai-match] RAG error for ${line.line_id}:`, err);
    }
  }

  return results;
}

/* ─── main ─────────────────────────────── */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");

  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY non configurata" }, 500);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurata" }, 500);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    const body = await req.json();
    const companyId = String(body.company_id || "");
    const lines: InputLine[] = body.lines || [];

    if (!companyId) return json({ error: "company_id richiesto" }, 400);
    if (lines.length === 0) return json({ error: "lines array vuoto" }, 400);
    if (lines.length > MAX_LINES) {
      return json({ error: `Massimo ${MAX_LINES} righe per chiamata` }, 400);
    }

    // Load data
    const [articles, examples] = await Promise.all([
      loadArticles(sql, companyId),
      loadConfirmedExamples(sql, companyId, 50),
    ]);

    if (articles.length === 0) {
      return json({ error: "Nessun articolo trovato per questa azienda" }, 400);
    }

    // Build article code → id map for resolution
    const codeToId = new Map(articles.map(a => [a.code, a.id]));

    // ─── RAG Level 2: Gemini embedding → search learning_examples ───
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
    let ragResults = new Map<string, RagMatch>();
    if (geminiKey) {
      try {
        ragResults = await ragMatchLines(sql, companyId, lines, geminiKey);
        console.log(`[article-ai-match] RAG resolved ${ragResults.size}/${lines.length} lines`);
      } catch (err) {
        console.warn("[article-ai-match] RAG phase error (continuing to Haiku):", err);
      }
    }

    // Filter out RAG-resolved lines before sending to Haiku
    const unmatchedLines = lines.filter(l => !ragResults.has(l.line_id));

    // If ALL lines resolved by RAG → skip Haiku entirely (cost = 0)
    if (unmatchedLines.length === 0) {
      const results = [...ragResults.values()].map(r => ({
        line_id: r.line_id,
        article_id: r.article_code ? (codeToId.get(r.article_code) || null) : null,
        article_code: r.article_code || null,
        confidence: r.confidence,
        reasoning: r.reasoning,
      }));
      const matched = results.filter(r => r.article_id).length;
      return json({
        results,
        stats: { total_lines: lines.length, matched, unmatched: lines.length - matched, rag_resolved: ragResults.size, haiku_called: false },
      });
    }

    // ─── Haiku Level 3: call Claude for remaining unmatched lines ───
    const prompt = buildPrompt(articles, examples, unmatchedLines);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        temperature: 0,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg = (errData as any)?.error?.message || `Anthropic ${response.status}`;
      return json({ error: `Errore AI: ${errMsg}` }, 502);
    }

    const aiData = await response.json();
    const textBlock = (aiData as any).content?.find((b: any) => b.type === "text");
    const rawText = textBlock?.text || "[]";

    // Parse JSON (strip markdown wrapping if present)
    let aiResults: AiResult[] = [];
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        aiResults = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.error("[article-ai-match] JSON parse error:", parseErr, "raw:", rawText.slice(0, 500));
      return json({ error: "Errore parsing risposta AI" }, 502);
    }

    // Merge RAG results + Haiku results
    const allResults = [
      // RAG-resolved lines first
      ...[...ragResults.values()].map(r => ({
        line_id: r.line_id,
        article_id: r.article_code ? (codeToId.get(r.article_code) || null) : null,
        article_code: r.article_code || null,
        confidence: r.confidence,
        reasoning: r.reasoning,
      })),
      // Haiku-resolved lines
      ...aiResults.map(r => ({
        line_id: r.line_id,
        article_id: r.article_code ? (codeToId.get(r.article_code) || null) : null,
        article_code: r.article_code || null,
        confidence: typeof r.confidence === "number" ? r.confidence : 0,
        reasoning: String(r.reasoning || ""),
      })),
    ];

    const matched = allResults.filter(r => r.article_id).length;

    return json({
      results: allResults,
      stats: {
        total_lines: lines.length,
        matched,
        unmatched: lines.length - matched,
        rag_resolved: ragResults.size,
        haiku_called: true,
        haiku_lines: unmatchedLines.length,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[article-ai-match] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
