// precompute-embeddings — Compute Gemini embeddings for entity tables
// (chart_of_accounts, categories, articles, projects)
// Cloned pattern from learning-embed, adapted for multi-entity embedding.
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;
const EMBED_CONCURRENCY = 8;
const MAX_BATCH = 50;
const REQUEST_TIMEOUT_MS = 30_000;

const VALID_ENTITY_TYPES = ["chart_of_accounts", "categories", "articles", "projects"] as const;
type EntityType = (typeof VALID_ENTITY_TYPES)[number];

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

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

/* ─── Gemini embedding ───────────────────── */

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiEmbedding(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EXPECTED_DIMS,
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini embedding error: ${msg}`);
  }

  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Gemini embedding vuoto");
  }

  const parsed = values.map((v: unknown) => Number(v));
  if (parsed.length !== EXPECTED_DIMS) {
    throw new Error(`Embedding dimensione inattesa (${parsed.length}, atteso ${EXPECTED_DIMS})`);
  }
  return parsed;
}

/* ─── Concurrency helper ─────────────────── */

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

/* ─── Build embedding text per entity type ── */

interface EntityRow {
  id: string;
  embed_text: string;
}

function buildAccountText(row: { code: string; name: string; section: string }): string {
  return `${row.code} ${row.name} — sezione: ${row.section}`;
}

function buildCategoryText(row: { name: string; type: string }): string {
  return `${row.name} — tipo: ${row.type}`;
}

function buildArticleText(row: { code: string; name: string; description: string | null; keywords: string[] }): string {
  let text = `${row.code} ${row.name}`;
  if (row.description) text += ` ${row.description}`;
  if (row.keywords?.length > 0) text += ` — keywords: ${row.keywords.join(", ")}`;
  return text;
}

function buildProjectText(row: { code: string; name: string }): string {
  return `${row.code} ${row.name}`;
}

/* ─── Process one entity type ────────────── */

async function processEntityType(
  sql: ReturnType<typeof postgres>,
  geminiKey: string,
  companyId: string,
  entityType: EntityType,
  batchSize: number,
): Promise<{ processed: number; errors: number; remaining: number }> {
  let rows: EntityRow[];

  switch (entityType) {
    case "chart_of_accounts":
      rows = (await sql`
        SELECT id, code, name, section FROM public.chart_of_accounts
        WHERE company_id = ${companyId} AND active = true AND is_header = false
          AND embedding IS NULL AND length(name) > 1
        ORDER BY code LIMIT ${batchSize}
      `).map((r) => ({ id: r.id, embed_text: buildAccountText(r as any) }));
      break;

    case "categories":
      rows = (await sql`
        SELECT id, name, type FROM public.categories
        WHERE company_id = ${companyId} AND active = true
          AND embedding IS NULL AND length(name) > 1
        ORDER BY sort_order, name LIMIT ${batchSize}
      `).map((r) => ({ id: r.id, embed_text: buildCategoryText(r as any) }));
      break;

    case "articles":
      rows = (await sql`
        SELECT id, code, name, description, keywords FROM public.articles
        WHERE company_id = ${companyId} AND active = true
          AND embedding IS NULL AND length(name) > 1
        ORDER BY code LIMIT ${batchSize}
      `).map((r) => ({ id: r.id, embed_text: buildArticleText(r as any) }));
      break;

    case "projects":
      rows = (await sql`
        SELECT id, code, name FROM public.projects
        WHERE company_id = ${companyId} AND status = 'active'
          AND embedding IS NULL AND length(name) > 1
        ORDER BY code LIMIT ${batchSize}
      `).map((r) => ({ id: r.id, embed_text: buildProjectText(r as any) }));
      break;

    default:
      return { processed: 0, errors: 0, remaining: 0 };
  }

  if (rows.length === 0) {
    return { processed: 0, errors: 0, remaining: 0 };
  }

  let processed = 0;
  let errors = 0;

  await runWithConcurrency(rows, EMBED_CONCURRENCY, async (row) => {
    try {
      const text = clip(row.embed_text, 2000);
      if (!text || text.length < 3) {
        errors += 1;
        return;
      }

      const vec = await callGeminiEmbedding(geminiKey, text);
      const vecLiteral = toVectorLiteral(vec);

      // Update the entity row with the embedding
      await sql.unsafe(
        `UPDATE public.${entityType} SET embedding = $1::halfvec(3072) WHERE id = $2`,
        [vecLiteral, row.id],
      );

      processed += 1;
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[precompute-embeddings] Error for ${entityType}/${row.id}:`, msg);
    }
  });

  // Count remaining unembedded
  let remaining = 0;
  switch (entityType) {
    case "chart_of_accounts": {
      const [r] = await sql`
        SELECT count(*)::int as count FROM public.chart_of_accounts
        WHERE company_id = ${companyId} AND active = true AND is_header = false AND embedding IS NULL`;
      remaining = r.count;
      break;
    }
    case "categories": {
      const [r] = await sql`
        SELECT count(*)::int as count FROM public.categories
        WHERE company_id = ${companyId} AND active = true AND embedding IS NULL`;
      remaining = r.count;
      break;
    }
    case "articles": {
      const [r] = await sql`
        SELECT count(*)::int as count FROM public.articles
        WHERE company_id = ${companyId} AND active = true AND embedding IS NULL`;
      remaining = r.count;
      break;
    }
    case "projects": {
      const [r] = await sql`
        SELECT count(*)::int as count FROM public.projects
        WHERE company_id = ${companyId} AND status = 'active' AND embedding IS NULL`;
      remaining = r.count;
      break;
    }
  }

  return { processed, errors, remaining };
}

/* ─── Main handler ───────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();

  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurata" }, 503);

  const body = await req.json().catch(() => ({})) as {
    company_id?: string;
    entity_types?: string[];
    batch_size?: number;
  };

  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const entityTypes = Array.isArray(body.entity_types)
    ? body.entity_types.filter((t): t is EntityType => VALID_ENTITY_TYPES.includes(t as EntityType))
    : [...VALID_ENTITY_TYPES];

  if (entityTypes.length === 0) return json({ error: "entity_types non validi" }, 400);

  const batchSize = Math.max(1, Math.min(body.batch_size || MAX_BATCH, MAX_BATCH));

  const sql = postgres(dbUrl, { max: 1 });

  try {
    const results: Record<string, { processed: number; errors: number; remaining: number }> = {};
    let totalProcessed = 0;
    let totalErrors = 0;

    for (const entityType of entityTypes) {
      console.log(`[precompute-embeddings] Processing ${entityType} for company ${companyId}...`);
      const result = await processEntityType(sql, geminiKey, companyId, entityType, batchSize);
      results[entityType] = result;
      totalProcessed += result.processed;
      totalErrors += result.errors;
      console.log(`[precompute-embeddings] ${entityType}: ${result.processed} processed, ${result.errors} errors, ${result.remaining} remaining`);
    }

    return json({
      status: "completed",
      processed_by_type: results,
      total_processed: totalProcessed,
      total_errors: totalErrors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[precompute-embeddings] Fatal error:", msg);
    return json({ error: clip(msg, 500), status: "failed" }, 500);
  } finally {
    await sql.end();
  }
});
