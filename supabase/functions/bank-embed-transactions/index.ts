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

type ClaimedTx = {
  id: string;
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

async function requireCompanyAccess(
  admin: ReturnType<typeof createClient>,
  token: string,
  companyId: string,
): Promise<void> {
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user?.id) {
    throw new Response(JSON.stringify({ error: "Sessione non valida" }), { status: 401 });
  }

  const { data: membership, error: membershipError } = await admin
    .from("company_members")
    .select("company_id")
    .eq("company_id", companyId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (membershipError || !membership?.company_id) {
    throw new Response(JSON.stringify({ error: "Permesso negato su azienda" }), { status: 403 });
  }
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed", request_id: requestId }, requestId, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase non configurato", request_id: requestId }, requestId, 500);
  }
  if (!geminiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY non configurata", request_id: requestId }, requestId, 503);
  }

  const token = getBearerToken(req);
  if (!token) {
    return jsonResponse({ error: "Authorization Bearer mancante", request_id: requestId }, requestId, 401);
  }

  let runId: string | null = null;
  let lockAcquired = false;
  let targetCompanyId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    const companyId = clip(body?.company_id, 64);
    const maxRows = Math.max(1, Math.min(Number(body?.max_rows ?? 400) || 400, 5000));
    const batchSize = Math.max(1, Math.min(Number(body?.batch_size ?? 60) || 60, 150));
    const ttlSeconds = Math.max(30, Math.min(Number(body?.ttl_seconds ?? 180) || 180, 900));
    const staleSeconds = Math.max(60, Math.min(Number(body?.stale_seconds ?? 900) || 900, 7200));

    if (!companyId) {
      return jsonResponse({ error: "company_id obbligatorio", request_id: requestId }, requestId, 400);
    }
    targetCompanyId = companyId;

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await requireCompanyAccess(admin, token, companyId);
    runId = crypto.randomUUID();

    const { data: lockRows, error: lockError } = await admin.rpc("bank_embedding_acquire_lock", {
      p_company_id: companyId,
      p_run_id: runId,
      p_ttl_seconds: ttlSeconds,
    });
    if (lockError) {
      return jsonResponse({
        error: `Errore acquisizione lock: ${lockError.message}`,
        request_id: requestId,
      }, requestId, 500);
    }

    const lock = Array.isArray(lockRows) && lockRows.length > 0 ? lockRows[0] : null;
    if (!lock?.acquired) {
      return jsonResponse({
        status: "already_running",
        run_id: lock?.current_run_id ?? null,
        lock_expires_at: lock?.expires_at ?? null,
        request_id: requestId,
      }, requestId, 200);
    }
    lockAcquired = true;

    const staleIso = new Date(Date.now() - (staleSeconds * 1000)).toISOString();
    await admin
      .from("bank_transactions")
      .update({
        embedding_status: "pending",
        embedding_error: "Requeued stale processing",
        embedding_updated_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("embedding_status", "processing")
      .lt("embedding_updated_at", staleIso);

    await admin
      .from("bank_transactions")
      .update({
        embedding_status: "pending",
        embedding_error: "Requeued stale processing (missing timestamp)",
        embedding_updated_at: new Date().toISOString(),
      })
      .eq("company_id", companyId)
      .eq("embedding_status", "processing")
      .is("embedding_updated_at", null);

    let processed = 0;
    let ready = 0;
    let errors = 0;

    while (processed < maxRows) {
      await admin.rpc("bank_embedding_heartbeat_lock", {
        p_company_id: companyId,
        p_run_id: runId,
        p_ttl_seconds: ttlSeconds,
      });

      const currentBatch = Math.min(batchSize, maxRows - processed);
      const { data: claimRows, error: claimError } = await admin.rpc("bank_embedding_claim_pending", {
        p_company_id: companyId,
        p_batch_size: currentBatch,
      });
      if (claimError) {
        throw new Error(`Errore claim pending: ${claimError.message}`);
      }

      const claimed = (Array.isArray(claimRows) ? claimRows : []) as ClaimedTx[];
      if (!claimed.length) break;

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

      for (let i = 0; i < claimed.length; i++) {
        const tx = claimed[i];
        const vec = batchEmbeddings[i] ?? [];
        if (vec.length === EXPECTED_EMBEDDING_DIMS) {
          const { error: applyError } = await admin.rpc("bank_embedding_apply_result", {
            p_company_id: companyId,
            p_tx_id: tx.id,
            p_embedding_text: toVectorLiteral(vec),
            p_embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
            p_error: null,
          });
          if (applyError) {
            errors++;
            await admin.rpc("bank_embedding_apply_result", {
              p_company_id: companyId,
              p_tx_id: tx.id,
              p_embedding_text: null,
              p_embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
              p_error: `Errore persistenza embedding: ${applyError.message}`,
            });
          } else {
            ready++;
          }
        } else {
          errors++;
          await admin.rpc("bank_embedding_apply_result", {
            p_company_id: companyId,
            p_tx_id: tx.id,
            p_embedding_text: null,
            p_embedding_model: `gemini:${GEMINI_EMBEDDING_MODEL}`,
            p_error: "Embedding non disponibile o dimensione non valida",
          });
        }
      }

      processed += claimed.length;
    }

    const { data: healthRows } = await admin.rpc("bank_embedding_health", { p_company_id: companyId });
    const health = Array.isArray(healthRows) && healthRows.length > 0 ? healthRows[0] : null;

    return jsonResponse({
      status: "completed",
      run_id: runId,
      processed,
      ready,
      errors,
      health,
      request_id: requestId,
    }, requestId, 200);
  } catch (e) {
    if (e instanceof Response) {
      const body = await e.text().catch(() => "{}");
      const parsed = (() => {
        try {
          return JSON.parse(body);
        } catch {
          return { error: body || "Errore non specificato" };
        }
      })();
      return jsonResponse({ ...parsed, request_id: requestId }, requestId, e.status || 500);
    }

    const msg = e instanceof Error ? e.message : "Errore sconosciuto";
    return jsonResponse({
      error: msg,
      status: "failed",
      run_id: runId,
      request_id: requestId,
    }, requestId, 500);
  } finally {
    if (lockAcquired && runId) {
      try {
        const supabaseUrlInner = Deno.env.get("SUPABASE_URL");
        const serviceRoleKeyInner = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (supabaseUrlInner && serviceRoleKeyInner) {
          const adminInner = createClient(supabaseUrlInner, serviceRoleKeyInner, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          if (targetCompanyId) {
            await adminInner.rpc("bank_embedding_release_lock", {
              p_company_id: targetCompanyId,
              p_run_id: runId,
            });
          }
        }
      } catch {
        // best effort
      }
    }
  }
});
