// memory-embed — Generate Gemini embeddings for company_memory rows
// Cloned from learning-embed, adapted for company_memory table.
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

/* ─── Main handler ───────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();

  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurata" }, 503);

  const body = await req.json().catch(() => ({})) as {
    memory_ids?: string[];
    company_id?: string;
    mode?: string;
    batch_size?: number;
  };

  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    let rows: { id: string; fact_text: string }[];

    if (body.mode === "backfill") {
      // Backfill mode: fetch unembedded active rows
      const batchSize = Math.max(1, Math.min(body.batch_size || 50, MAX_BATCH));
      rows = await sql`
        SELECT id, fact_text FROM public.company_memory
        WHERE company_id = ${companyId}
          AND embedding IS NULL
          AND active = true
          AND length(fact_text) > 3
        ORDER BY created_at
        LIMIT ${batchSize}
      `;
    } else {
      // Explicit IDs mode
      const ids = Array.isArray(body.memory_ids)
        ? body.memory_ids.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, MAX_BATCH)
        : [];
      if (ids.length === 0) return json({ error: "memory_ids vuoto" }, 400);

      rows = await sql`
        SELECT id, fact_text FROM public.company_memory
        WHERE id = ANY(${ids})
          AND company_id = ${companyId}
          AND active = true
      `;
    }

    if (rows.length === 0) {
      const [{ count: remaining }] = await sql`
        SELECT count(*)::int as count FROM public.company_memory
        WHERE company_id = ${companyId} AND embedding IS NULL AND active = true
      `;
      return json({ processed: 0, errors: 0, remaining, status: "no_rows" });
    }

    let processed = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    await runWithConcurrency(rows, EMBED_CONCURRENCY, async (row) => {
      try {
        const text = clip(row.fact_text, 2000);
        if (!text || text.length < 3) {
          errors += 1;
          return;
        }

        const vec = await callGeminiEmbedding(geminiKey, text);
        const vecLiteral = toVectorLiteral(vec);

        await sql`
          UPDATE public.company_memory
          SET embedding = ${vecLiteral}::halfvec(3072)
          WHERE id = ${row.id}
        `;

        processed += 1;
      } catch (err) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errorDetails.push(`${row.id}: ${clip(msg, 200)}`);
        console.error(`[memory-embed] Error for ${row.id}:`, msg);
      }
    });

    // Count remaining unembedded
    const [{ count: remaining }] = await sql`
      SELECT count(*)::int as count FROM public.company_memory
      WHERE company_id = ${companyId} AND embedding IS NULL AND active = true
    `;

    return json({
      status: "completed",
      processed,
      errors,
      remaining,
      ...(errorDetails.length > 0 ? { error_details: errorDetails.slice(0, 5) } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory-embed] Fatal error:", msg);
    return json({ error: clip(msg, 500), status: "failed" }, 500);
  } finally {
    await sql.end();
  }
});
