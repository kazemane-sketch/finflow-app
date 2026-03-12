import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUEST_TIMEOUT_MS = Number(Deno.env.get("BANK_EMBED_TIMEOUT_MS") ?? "30000");
const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_EMBEDDING_DIMS = Math.max(1, Number(Deno.env.get("BANK_EMBEDDING_DIMS") ?? "3072") || 3072);
const MAX_ERROR_LEN = 500;
const EMBED_CONCURRENCY = Math.max(1, Math.min(Number(Deno.env.get("BANK_EMBED_CONCURRENCY") ?? "8") || 8, 20));

type EmbeddingTx = {
  id: string;
  company_id: string;
  date: string | null;
  value_date: string | null;
  amount: number | null;
  description: string | null;
  counterparty_name: string | null;
  transaction_type: string | null;
  reference: string | null;
  invoice_ref: string | null;
  notes: string | null;
  direction: "in" | "out" | null;
  raw_text: string | null;
  extracted_refs: Record<string, unknown> | string | null;
};

type GlobalHealth = {
  total_rows: number;
  ready_rows: number;
  processing_rows: number;
  pending_rows: number;
  error_rows: number;
};

type EmbedRequestBody = {
  company_id?: string;
  batch_ids?: unknown;
  skip_claim?: boolean;
};

function jsonResponse(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function clip(v: unknown, max = 500): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function resolveSupabaseUrl(req: Request): string {
  try {
    const url = new URL(req.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return (Deno.env.get("SUPABASE_URL") ?? "").trim();
  }
}

function parseJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function isServiceRoleToken(token: string | null, expectedServiceRoleKey: string): boolean {
  if (!token) return false;
  if (expectedServiceRoleKey && token === expectedServiceRoleKey) return true;
  return parseJwtRole(token) === "service_role";
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

function buildEmbeddingText(tx: EmbeddingTx): string {
  const direction = tx.direction === "in" ? "entrata" : tx.direction === "out" ? "uscita" : "n.d.";
  const amount = typeof tx.amount === "number" ? tx.amount.toFixed(2) : "0.00";
  const parts = [
    `Data: ${clip(tx.date, 20) || "n.d."}`,
    `Data valuta: ${clip(tx.value_date, 20) || "n.d."}`,
    `Importo: ${amount}`,
    `Direzione: ${direction}`,
    `Tipo: ${clip(tx.transaction_type, 40) || "altro"}`,
    `Controparte: ${clip(tx.counterparty_name, 120) || "n.d."}`,
    `Descrizione: ${clip(tx.description, 300) || "n.d."}`,
    `Riferimento: ${clip(tx.reference, 120) || "n.d."}`,
    `Rif fattura: ${clip(tx.invoice_ref, 80) || "n.d."}`,
  ];
  if (tx.notes) {
    parts.push(`Note utente: ${clip(tx.notes, 600)}`);
  }
  if (tx.raw_text) {
    parts.push(`Testo operazione completo: ${clip(tx.raw_text, 1500)}`);
  }
  if (tx.extracted_refs) {
    try {
      const refs = typeof tx.extracted_refs === 'string' ? JSON.parse(tx.extracted_refs) : tx.extracted_refs;
      if (refs.invoice_refs?.length) parts.push(`Fatture citate: ${refs.invoice_refs.join(', ')}`);
      if (refs.mandate_id) parts.push(`Mandato: ${refs.mandate_id}`);
      if (refs.contract_number) parts.push(`Contratto: ${refs.contract_number}`);
      if (refs.causal_code) parts.push(`Causale: ${refs.causal_code}`);
    } catch { /* ignore parse errors */ }
  }
  return parts.join("\n");
}

function toErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "Errore sconosciuto");
  return clip(msg, MAX_ERROR_LEN);
}

function parseBatchIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((v) => typeof v === "string" ? v.trim() : "")
    .filter((v) => v.length > 0);
  return Array.from(new Set(ids));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiEmbeddingSingle(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EXPECTED_EMBEDDING_DIMS,
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini embedding error: ${msg}`);
  }

  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Gemini embedding vuoto");
  }

  const parsed = values.map((v: unknown) => Number(v));
  if (parsed.length !== EXPECTED_EMBEDDING_DIMS) {
    throw new Error(`Embedding dimensione inattesa (${parsed.length}, atteso ${EXPECTED_EMBEDDING_DIMS})`);
  }
  return parsed;
}

async function countRows(
  serviceClient: ReturnType<typeof createClient>,
  status?: "ready" | "processing" | "pending" | "error",
): Promise<number> {
  let query = serviceClient.from("bank_transactions").select("id", { count: "exact", head: true });
  if (status) query = query.eq("embedding_status", status);
  const { count, error } = await query;
  if (error) throw new Error(`Count ${status ?? "total"} failed: ${error.message}`);
  return Number(count || 0);
}

async function fetchGlobalHealth(serviceClient: ReturnType<typeof createClient>): Promise<GlobalHealth> {
  const [total_rows, ready_rows, processing_rows, pending_rows, error_rows] = await Promise.all([
    countRows(serviceClient),
    countRows(serviceClient, "ready"),
    countRows(serviceClient, "processing"),
    countRows(serviceClient, "pending"),
    countRows(serviceClient, "error"),
  ]);

  return {
    total_rows,
    ready_rows,
    processing_rows,
    pending_rows,
    error_rows,
  };
}

async function markRowError(
  serviceClient: ReturnType<typeof createClient>,
  id: string,
  message: string,
): Promise<void> {
  await serviceClient
    .from("bank_transactions")
    .update({
      embedding_status: "error",
      embedding_model: EMBEDDING_MODEL,
      embedding_error: clip(message, MAX_ERROR_LEN),
      embedding_updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

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

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed", request_id: requestId }, requestId, 405);
  }

  const supabaseUrl = resolveSupabaseUrl(req);
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const expectedServiceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const bearer = getBearerToken(req);

  if (!supabaseUrl) {
    return jsonResponse({ error: "Supabase non configurato", request_id: requestId }, requestId, 500);
  }
  if (!geminiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY non configurata", request_id: requestId }, requestId, 503);
  }
  if (!isServiceRoleToken(bearer, expectedServiceRoleKey)) {
    return jsonResponse({
      error: "Richiesta non autorizzata: service_role required",
      error_code: "AUTH_SERVICE_ROLE_REQUIRED",
      request_id: requestId,
    }, requestId, 401);
  }

  const body = await req.json().catch(() => ({})) as EmbedRequestBody;
  if (body?.skip_claim !== true) {
    return jsonResponse({
      error: "use skip_claim mode",
      error_code: "EMBED_SKIP_CLAIM_REQUIRED",
      request_id: requestId,
    }, requestId, 400);
  }

  const batchIds = parseBatchIds(body?.batch_ids);
  if (!batchIds.length) {
    return jsonResponse({
      error: "batch_ids vuoto o non valido",
      error_code: "EMBED_BATCH_IDS_REQUIRED",
      request_id: requestId,
    }, requestId, 400);
  }

  const companyId = typeof body?.company_id === "string" ? body.company_id.trim() : "";
  const serviceRoleKey = bearer as string;
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: rows, error: rowsError } = await serviceClient
      .from("bank_transactions")
      .select("id,company_id,date,value_date,amount,description,counterparty_name,transaction_type,reference,invoice_ref,notes,direction,raw_text,extracted_refs")
      .in("id", batchIds);

    if (rowsError) {
      return jsonResponse({
        error: `Errore fetch batch: ${rowsError.message}`,
        request_id: requestId,
      }, requestId, 500);
    }

    const txRows = (Array.isArray(rows) ? rows : []) as EmbeddingTx[];
    const byId = new Map(txRows.map((tx) => [tx.id, tx]));
    const missingIds = batchIds.filter((id) => !byId.has(id));

    let ready = 0;
    let errors = 0;

    if (missingIds.length) {
      errors += missingIds.length;
      await Promise.all(missingIds.map((id) =>
        markRowError(serviceClient, id, "Movimento non trovato nel batch claim")
      ));
    }

    await runWithConcurrency(txRows, EMBED_CONCURRENCY, async (tx) => {
      if (companyId && tx.company_id !== companyId) {
        errors += 1;
        await markRowError(serviceClient, tx.id, "company_id non coerente con il batch claim");
        return;
      }

      try {
        const text = buildEmbeddingText(tx);
        const vec = await callGeminiEmbeddingSingle(geminiKey, text);

        const { error: updateError } = await serviceClient
          .from("bank_transactions")
          .update({
            embedding: toVectorLiteral(vec),
            embedding_status: "ready",
            embedding_model: EMBEDDING_MODEL,
            embedding_error: null,
            embedding_updated_at: new Date().toISOString(),
          })
          .eq("id", tx.id)
          .eq("company_id", tx.company_id);

        if (updateError) {
          throw new Error(`Errore persistenza embedding: ${updateError.message}`);
        }

        ready += 1;
      } catch (error) {
        errors += 1;
        await markRowError(serviceClient, tx.id, toErrorMessage(error));
      }
    });

    const health = await fetchGlobalHealth(serviceClient);
    return jsonResponse({
      status: "completed",
      mode: "skip_claim",
      processed: txRows.length,
      requested: batchIds.length,
      ready,
      errors,
      health,
      request_id: requestId,
    }, requestId, 200);
  } catch (error) {
    return jsonResponse({
      error: toErrorMessage(error),
      status: "failed",
      request_id: requestId,
    }, requestId, 500);
  }
});
