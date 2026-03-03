import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUEST_TIMEOUT_MS = Number(Deno.env.get("BANK_EMBED_TIMEOUT_MS") ?? "30000");
const GEMINI_EMBEDDING_MODEL = Deno.env.get("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-001";
const EXPECTED_EMBEDDING_DIMS = 3072;
const STALE_PROCESSING_SECONDS = Math.max(60, Math.min(Number(Deno.env.get("BANK_EMBED_STALE_SECONDS") ?? "1800") || 1800, 86400));

type ClaimedTx = {
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
  direction: "in" | "out" | null;
};

type GlobalHealth = {
  total_rows: number;
  ready_rows: number;
  processing_rows: number;
  pending_rows: number;
  error_rows: number;
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

function getApiKey(req: Request): string | null {
  const raw = req.headers.get("apikey") ?? req.headers.get("x-api-key");
  return raw?.trim() || null;
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

function isServiceRoleCredential(value: string | null, serviceRoleKey: string): boolean {
  if (!value) return false;
  if (value === serviceRoleKey) return true;
  return parseJwtRole(value) === "service_role";
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

function buildEmbeddingText(tx: ClaimedTx): string {
  const direction = tx.direction === "in" ? "entrata" : tx.direction === "out" ? "uscita" : "n.d.";
  const amount = typeof tx.amount === "number" ? tx.amount.toFixed(2) : "0.00";
  return [
    `Data: ${clip(tx.date, 20) || "n.d."}`,
    `Data valuta: ${clip(tx.value_date, 20) || "n.d."}`,
    `Importo: ${amount}`,
    `Direzione: ${direction}`,
    `Tipo: ${clip(tx.transaction_type, 40) || "altro"}`,
    `Controparte: ${clip(tx.counterparty_name, 120) || "n.d."}`,
    `Descrizione: ${clip(tx.description, 260) || "n.d."}`,
    `Riferimento: ${clip(tx.reference, 120) || "n.d."}`,
    `Rif fattura: ${clip(tx.invoice_ref, 80) || "n.d."}`,
  ].join("\n");
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini embedding error: ${msg}`);
  }

  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_EMBEDDING_DIMS) {
    throw new Error(`Embedding dimensione inattesa (${Array.isArray(values) ? values.length : "n/a"})`);
  }
  return values.map((v: unknown) => Number(v));
}

async function callGeminiEmbeddingBatch(apiKey: string, texts: string[]): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      })),
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini batch embedding error: ${msg}`);
  }

  const embeddings = Array.isArray(payload?.embeddings) ? payload.embeddings : [];
  if (!embeddings.length) throw new Error("Gemini batch embedding vuoto");

  return embeddings.map((entry: any) => {
    const values = entry?.values;
    if (!Array.isArray(values) || values.length !== EXPECTED_EMBEDDING_DIMS) {
      throw new Error(`Embedding batch dimensione inattesa (${Array.isArray(values) ? values.length : "n/a"})`);
    }
    return values.map((v: unknown) => Number(v));
  });
}

async function countRows(serviceClient: ReturnType<typeof createClient>, status?: "ready" | "processing" | "pending" | "error"): Promise<number> {
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

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed", request_id: requestId }, requestId, 405);
  }

  const supabaseUrl = resolveSupabaseUrl(req);
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();

  if (!supabaseUrl) {
    return jsonResponse({ error: "Supabase non configurato", request_id: requestId }, requestId, 500);
  }
  if (!serviceRoleKey) {
    return jsonResponse({ error: "SUPABASE_SERVICE_ROLE_KEY non configurata", request_id: requestId }, requestId, 500);
  }
  if (!geminiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY non configurata", request_id: requestId }, requestId, 503);
  }

  const bearer = getBearerToken(req);
  const apiKey = getApiKey(req);
  const authorized = isServiceRoleCredential(bearer, serviceRoleKey) || isServiceRoleCredential(apiKey, serviceRoleKey);
  if (!authorized) {
    return jsonResponse({
      error: "Richiesta non autorizzata: service_role required",
      error_code: "AUTH_SERVICE_ROLE_REQUIRED",
      request_id: requestId,
    }, requestId, 401);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    await req.json().catch(() => ({}));

    const staleIso = new Date(Date.now() - (STALE_PROCESSING_SECONDS * 1000)).toISOString();
    await serviceClient
      .from("bank_transactions")
      .update({
        embedding_status: "pending",
        embedding_error: "Requeued stale processing",
        embedding_updated_at: new Date().toISOString(),
      })
      .eq("embedding_status", "processing")
      .lt("embedding_updated_at", staleIso);

    await serviceClient
      .from("bank_transactions")
      .update({
        embedding_status: "pending",
        embedding_error: "Requeued stale processing (missing timestamp)",
        embedding_updated_at: new Date().toISOString(),
      })
      .eq("embedding_status", "processing")
      .is("embedding_updated_at", null);

    const { data: claimRows, error: claimError } = await serviceClient
      .rpc("bank_embedding_claim_batch");

    if (claimError) {
      return jsonResponse({
        error: `Errore claim batch: ${claimError.message}`,
        request_id: requestId,
      }, requestId, 500);
    }

    const claimed = (Array.isArray(claimRows) ? claimRows : []) as ClaimedTx[];
    if (!claimed.length) {
      const health = await fetchGlobalHealth(serviceClient);
      return jsonResponse({
        status: "completed",
        processed: 0,
        ready: 0,
        errors: 0,
        health,
        request_id: requestId,
      }, requestId, 200);
    }

    const texts = claimed.map((tx) => buildEmbeddingText(tx));
    let batchEmbeddings: number[][] = [];

    try {
      batchEmbeddings = await callGeminiEmbeddingBatch(geminiKey, texts);
    } catch {
      batchEmbeddings = [];
    }

    if (batchEmbeddings.length !== claimed.length) {
      batchEmbeddings = [];
      for (const text of texts) {
        try {
          batchEmbeddings.push(await callGeminiEmbeddingSingle(geminiKey, text));
        } catch {
          batchEmbeddings.push([]);
        }
      }
    }

    let ready = 0;
    let errors = 0;

    for (let i = 0; i < claimed.length; i++) {
      const tx = claimed[i];
      const vec = batchEmbeddings[i] ?? [];

      if (vec.length === EXPECTED_EMBEDDING_DIMS) {
        const { error } = await serviceClient
          .from("bank_transactions")
          .update({
            embedding: toVectorLiteral(vec),
            embedding_status: "ready",
            embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
            embedding_error: null,
            embedding_updated_at: new Date().toISOString(),
          })
          .eq("id", tx.id)
          .eq("company_id", tx.company_id);

        if (error) {
          errors++;
          await serviceClient
            .from("bank_transactions")
            .update({
              embedding_status: "error",
              embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
              embedding_error: `Errore persistenza embedding: ${error.message}`.slice(0, 500),
              embedding_updated_at: new Date().toISOString(),
            })
            .eq("id", tx.id)
            .eq("company_id", tx.company_id);
        } else {
          ready++;
        }
      } else {
        errors++;
        await serviceClient
          .from("bank_transactions")
          .update({
            embedding_status: "error",
            embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
            embedding_error: "Embedding non disponibile o dimensione non valida",
            embedding_updated_at: new Date().toISOString(),
          })
          .eq("id", tx.id)
          .eq("company_id", tx.company_id);
      }
    }

    const health = await fetchGlobalHealth(serviceClient);
    return jsonResponse({
      status: "completed",
      processed: claimed.length,
      ready,
      errors,
      health,
      request_id: requestId,
    }, requestId, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Errore sconosciuto";
    return jsonResponse({
      error: msg,
      status: "failed",
      request_id: requestId,
    }, requestId, 500);
  }
});
