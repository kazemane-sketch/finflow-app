import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUEST_TIMEOUT_MS = Number(Deno.env.get("BANK_AI_SEARCH_TIMEOUT_MS") ?? "30000");
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_EMBEDDING_DIMS = Math.max(1, Number(Deno.env.get("BANK_AI_EMBEDDING_DIMS") ?? "3072") || 3072);
const MAX_CANDIDATES = 50;

type DirectionFilter = "all" | "in" | "out";
type AiMode = "filter" | "analysis";
type AppErrorPayload = {
  status: number;
  error: string;
  error_code: string;
  hint?: string;
  details?: string;
  mode?: AiMode;
};

type RpcError = {
  status: number;
  message: string;
  details?: string;
};

type CandidateTx = {
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
  raw_text?: string | null;
  similarity?: number | null;
};

type BankFilterSpec = {
  counterparty: string | null;
  direction: DirectionFilter;
  transaction_types: string[];
  amount_min: number | null;
  amount_max: number | null;
  date_from: string | null;
  date_to: string | null;
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

function appError(
  status: number,
  error: string,
  errorCode: string,
  hint?: string,
  details?: string,
  mode?: AiMode,
): AppErrorPayload {
  return {
    status,
    error,
    error_code: errorCode,
    hint,
    details,
    mode,
  };
}

function isAppErrorPayload(e: unknown): e is AppErrorPayload {
  const x = e as AppErrorPayload | null;
  return !!x && typeof x.status === "number" && typeof x.error === "string" && typeof x.error_code === "string";
}

function errorResponse(err: AppErrorPayload, requestId: string): Response {
  return jsonResponse({
    error: err.error,
    error_code: err.error_code,
    hint: err.hint,
    details: err.details,
    mode: err.mode,
    request_id: requestId,
  }, requestId, err.status);
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

function clip(v: unknown, max = 500): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function parseDateIso(v: unknown): string | null {
  const s = clip(v, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseDirection(v: unknown): DirectionFilter {
  const s = clip(v, 10).toLowerCase();
  if (s === "in" || s === "out") return s;
  return "all";
}

function parseAmountIT(value: string): number | null {
  const normalized = value
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function parseYearRange(query: string): { from: string; to: string } | null {
  const yearMatch = query.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);
  if (year < 2000 || year > 2100) return null;
  return {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  };
}

function parseQuarterRange(query: string): { from: string; to: string } | null {
  const q = query.toLowerCase();
  const quarterMatch = q.match(/\bq([1-4])\b/) || q.match(/\b([1-4])(?:o|°)?\s*trimestre\b/);
  if (!quarterMatch) return null;
  const quarter = Number(quarterMatch[1]);
  const yearRange = parseYearRange(q);
  const year = yearRange ? Number(yearRange.from.slice(0, 4)) : new Date().getFullYear();
  const quarterRanges: Record<number, { from: string; to: string }> = {
    1: { from: `${year}-01-01`, to: `${year}-03-31` },
    2: { from: `${year}-04-01`, to: `${year}-06-30` },
    3: { from: `${year}-07-01`, to: `${year}-09-30` },
    4: { from: `${year}-10-01`, to: `${year}-12-31` },
  };
  return quarterRanges[quarter] ?? null;
}

function extractCounterparty(query: string): string | null {
  const lower = query.toLowerCase();
  const m = lower.match(/\b(?:da|verso|a favore di|a)\s+([a-z0-9 .&'/-]{3,})$/i);
  if (!m?.[1]) return null;
  const candidate = m[1].trim();
  if (!candidate) return null;
  if (/(?:\b(202\d|q[1-4]|trimestre|bonific|sdd|f24|moviment|sopra|sotto)\b)/i.test(candidate)) return null;
  return candidate;
}

function detectTransactionTypes(query: string): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  if (/\bbonific/i.test(q)) out.push("bonifico_in", "bonifico_out");
  if (/\bsdd\b|\brid\b/i.test(q)) out.push("sdd");
  if (/\briba\b/i.test(q)) out.push("riba");
  if (/\bf24\b/i.test(q)) out.push("f24");
  if (/\bcommission/i.test(q)) out.push("commissione");
  if (/\bstipend/i.test(q)) out.push("stipendio");
  if (/\bpos\b/i.test(q)) out.push("pos");
  if (/\bpreliev/i.test(q)) out.push("prelievo");
  return Array.from(new Set(out));
}

function detectDirection(query: string): DirectionFilter {
  const q = query.toLowerCase();
  const hasIn = /\b(entrat|incass|accredit|ricevut)/i.test(q);
  const hasOut = /\b(uscit|pagament|addebito|spes|fornitor|f24|sdd|rid)/i.test(q);
  if (hasIn && !hasOut) return "in";
  if (hasOut && !hasIn) return "out";
  return "all";
}

function detectAmountBounds(query: string): { min: number | null; max: number | null } {
  const q = query.toLowerCase();
  const numbers = Array.from(q.matchAll(/(?:€\s*)?-?\d[\d.,]*/g))
    .map((m) => parseAmountIT(m[0]))
    .filter((v): v is number => v != null && v > 0);

  if (!numbers.length) return { min: null, max: null };

  const between = q.match(/(?:tra|fra)\s+([0-9.,\s€]+)\s+(?:e|-)\s+([0-9.,\s€]+)/i);
  if (between?.[1] && between?.[2]) {
    const a = parseAmountIT(between[1]);
    const b = parseAmountIT(between[2]);
    if (a != null && b != null) return { min: Math.min(a, b), max: Math.max(a, b) };
  }

  if (/\b(sopra|oltre|maggior|superior|almeno)\b/i.test(q)) return { min: numbers[0], max: null };
  if (/\b(sotto|inferior|minor|massimo|fino a)\b/i.test(q)) return { min: null, max: numbers[0] };
  return { min: null, max: null };
}

function isFilterMode(query: string): boolean {
  const q = query.toLowerCase();
  const filterKeywords = /\b(tutti|tutte|elenco|lista|mostra|fammi vedere|movimenti|bonific|sdd|rid|f24|sopra|sotto|dal|al|nel|del)\b/i;
  const analysisKeywords = /\b(quanto|totale|somma|media|trend|analizza|analisi|doppi|duplicati|anomali|perche|motivo)\b/i;
  return filterKeywords.test(q) && !analysisKeywords.test(q);
}

function buildFilterSpec(rawQuery: string): BankFilterSpec {
  const query = rawQuery.toLowerCase();
  const yearRange = parseYearRange(query);
  const quarterRange = parseQuarterRange(query);
  const amountBounds = detectAmountBounds(query);
  const txTypes = detectTransactionTypes(query);

  return {
    counterparty: extractCounterparty(rawQuery),
    direction: detectDirection(query),
    transaction_types: txTypes,
    amount_min: amountBounds.min,
    amount_max: amountBounds.max,
    date_from: quarterRange?.from ?? yearRange?.from ?? null,
    date_to: quarterRange?.to ?? yearRange?.to ?? null,
  };
}

function buildPrompt(query: string, candidates: CandidateTx[]): string {
  return [
    "Sei un assistente contabile che risponde a domande su movimenti bancari.",
    "Usa SOLO i movimenti forniti in input.",
    "Non inventare dati o transazioni mancanti.",
    "Se mancano dati sufficienti, dillo chiaramente.",
    "Rispondi in italiano, in modo pratico e sintetico.",
    "",
    `Domanda utente: ${query}`,
    "",
    `Movimenti candidati (${candidates.length}):`,
    JSON.stringify(candidates),
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

async function callAnthropic(apiKey: string, prompt: string): Promise<string> {
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1400,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Anthropic error: ${msg}`);
  }

  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const text = blocks
    .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic empty response");
  return text;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

function isRpcErrorPayload(e: unknown): e is RpcError {
  const x = e as RpcError | null;
  return !!x && typeof x.status === "number" && typeof x.message === "string";
}

async function callGeminiEmbedding(apiKey: string, query: string): Promise<number[]> {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: { parts: [{ text: query }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EXPECTED_EMBEDDING_DIMS,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

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

function getDbUrlOrThrow(): string {
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) {
    throw {
      status: 500,
      message: "SUPABASE_DB_URL non configurato",
      details: "Configura SUPABASE_DB_URL nei secrets delle Edge Functions.",
    } satisfies RpcError;
  }
  return dbUrl;
}

async function callBankAiSearchCandidatesText(
  companyId: string,
  query: string,
  limit: number,
): Promise<CandidateTx[]> {
  const sql = postgres(getDbUrlOrThrow());
  try {
    const words = query.trim().split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2);
    if (!words.length) {
      console.log("[text-search] words:", words, "found:", 0);
      return [];
    }

    const wordConditions = words.map((_, i) =>
      `(raw_text ILIKE '%' || $${i + 2} || '%' OR description ILIKE '%' || $${i + 2} || '%' OR reference ILIKE '%' || $${i + 2} || '%' OR invoice_ref ILIKE '%' || $${i + 2} || '%' OR counterparty_name ILIKE '%' || $${i + 2} || '%')`
    ).join(" AND ");

    const sqlQuery = `
      SELECT
        id,
        date,
        value_date,
        amount,
        description,
        counterparty_name,
        transaction_type,
        reference,
        invoice_ref,
        direction,
        raw_text,
        0::numeric AS similarity
      FROM public.bank_transactions
      WHERE company_id = $1
        AND ${wordConditions}
      ORDER BY date DESC
      LIMIT $${words.length + 2}
    `;
    const params = [companyId, ...words, limit];
    const rows = await sql.unsafe(sqlQuery, params) as unknown as CandidateTx[];
    console.log("[text-search] words:", words, "found:", Array.isArray(rows) ? rows.length : 0);

    if (!Array.isArray(rows)) {
      throw {
        status: 500,
        message: "Payload SQL non valido",
        details: typeof rows === "string" ? rows : JSON.stringify(rows),
      } satisfies RpcError;
    }
    return rows as CandidateTx[];
  } catch (e) {
    const pgErr = e as { message?: string; detail?: string; hint?: string; code?: string };
    const details = [pgErr?.detail, pgErr?.hint, pgErr?.code].filter(Boolean).join(" | ") || undefined;
    throw {
      status: 500,
      message: pgErr?.message || "Errore query candidati testuali",
      details,
    } satisfies RpcError;
  } finally {
    await sql.end();
  }
}

async function callBankAiSearchCandidatesRpc(
  companyId: string,
  queryVector: string,
  limit: number,
  direction: DirectionFilter,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<CandidateTx[]> {
  const sql = postgres(getDbUrlOrThrow());
  try {
    const rows = await sql<CandidateTx[]>`
      SELECT
        id,
        date,
        value_date,
        amount,
        description,
        counterparty_name,
        transaction_type,
        reference,
        invoice_ref,
        direction,
        raw_text,
        (embedding <=> ${queryVector}::vector(3072))::numeric AS similarity
      FROM public.bank_transactions
      WHERE company_id = ${companyId}
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND (${direction} = 'all' OR direction = ${direction})
        AND (${dateFrom}::date IS NULL OR date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR date <= ${dateTo}::date)
      ORDER BY embedding <=> ${queryVector}::vector(3072), date DESC, id
      LIMIT ${limit}
    `;

    if (!Array.isArray(rows)) {
      throw {
        status: 500,
        message: "Payload SQL non valido",
        details: typeof rows === "string" ? rows : JSON.stringify(rows),
      } satisfies RpcError;
    }

    return rows as CandidateTx[];
  } catch (e) {
    const pgErr = e as { message?: string; detail?: string; hint?: string; code?: string };
    const details = [pgErr?.detail, pgErr?.hint, pgErr?.code].filter(Boolean).join(" | ") || undefined;
    throw {
      status: 500,
      message: pgErr?.message || "Errore query candidati Postgres",
      details,
    } satisfies RpcError;
  } finally {
    await sql.end();
  }
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

async function requireCompanyAccess(
  userClient: ReturnType<typeof createClient>,
  token: string,
  companyId: string,
  requestId: string,
): Promise<void> {
  const role = parseJwtRole(token);
  if (role === "anon") {
    throw appError(
      401,
      "Token anon non valido per questa operazione",
      "AUTH_USER_TOKEN_REQUIRED",
      "Effettua il login utente e riprova.",
    );
  }

  const { data: membership, error: membershipError } = await userClient
    .from("company_members")
    .select("company_id")
    .eq("company_id", companyId)
    .maybeSingle();

  if (membershipError) {
    const msg = membershipError.message || "";
    const isJwtError = /jwt|auth|token|session|expired|invalid/i.test(msg);
    console.error(JSON.stringify({
      request_id: requestId,
      company_id: companyId,
      auth_stage: "company_membership_query",
      supabase_error: membershipError.message,
    }));
    if (isJwtError) {
      throw appError(
        401,
        "JWT non valido o scaduto",
        "AUTH_INVALID_JWT",
        "Effettua nuovamente il login.",
        membershipError.message,
      );
    }
    throw appError(
      500,
      "Errore verifica permessi azienda",
      "AUTH_MEMBERSHIP_QUERY_FAILED",
      "Riprova tra pochi secondi.",
      membershipError.message,
    );
  }

  if (!membership?.company_id) {
    throw appError(
      403,
      "Permesso negato su azienda",
      "AUTH_COMPANY_FORBIDDEN",
      "Verifica di essere membro dell'azienda selezionata.",
    );
  }
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return errorResponse(appError(405, "Method not allowed", "METHOD_NOT_ALLOWED"), requestId);
  }

  const supabaseUrl = resolveSupabaseUrl(req);
  const apiKey = getApiKey(req);
  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!supabaseUrl) {
    return errorResponse(appError(500, "Supabase non configurato", "CONFIG_SUPABASE_MISSING"), requestId);
  }
  if (!apiKey) {
    return errorResponse(appError(
      401,
      "API key mancante",
      "AUTH_APIKEY_MISSING",
      "Invia header apikey con la anon key del progetto.",
    ), requestId);
  }

  const token = getBearerToken(req);
  if (!token) {
    return errorResponse(appError(
      401,
      "Authorization Bearer mancante",
      "AUTH_BEARER_MISSING",
      "Invia il JWT utente in header Authorization.",
    ), requestId);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const query = clip(body?.query, 500);
    const companyId = clip(body?.company_id, 64);
    const direction = parseDirection(body?.direction);
    const dateFrom = parseDateIso(body?.date_from);
    const dateTo = parseDateIso(body?.date_to);
    const limit = Math.max(1, Math.min(Number(body?.limit ?? MAX_CANDIDATES) || MAX_CANDIDATES, MAX_CANDIDATES));

    if (!query) {
      return errorResponse(appError(400, "query obbligatoria", "VALIDATION_QUERY_REQUIRED"), requestId);
    }
    if (!companyId) {
      return errorResponse(appError(400, "company_id obbligatorio", "VALIDATION_COMPANY_REQUIRED"), requestId);
    }

    const userClient = createClient(supabaseUrl, apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    await requireCompanyAccess(userClient, token, companyId, requestId);

    if (isFilterMode(query)) {
      const filters = buildFilterSpec(query);
      return jsonResponse({
        mode: "filter" as AiMode,
        filters,
        answer: "Filtri strutturati estratti dalla richiesta. Applico la vista elenco completa.",
        candidate_count: 0,
        used_count: 0,
        model: "bank-filter-parser:v1",
        request_id: requestId,
      }, requestId, 200);
    }

    if (!anthropicKey) {
      return errorResponse(appError(
        503,
        "ANTHROPIC_API_KEY non configurata",
        "CONFIG_ANTHROPIC_API_KEY_MISSING",
        "Configura il secret ANTHROPIC_API_KEY nelle Edge Functions.",
        undefined,
        "analysis",
      ), requestId);
    }

    let candidates: CandidateTx[] = [];
    try {
      candidates = await callBankAiSearchCandidatesText(
        companyId,
        query,
        limit,
      );
    } catch (e) {
      const status = isRpcErrorPayload(e) ? e.status : 500;
      const msg = isRpcErrorPayload(e) ? e.message : (e instanceof Error ? e.message : "Errore SQL sconosciuto");
      const details = isRpcErrorPayload(e) ? e.details : undefined;
      const isJwtError = status === 401 || status === 403 || /jwt|auth|token|session|expired|invalid/i.test(msg);
      console.error(JSON.stringify({
        request_id: requestId,
        company_id: companyId,
        auth_stage: "bank_ai_search_candidates_text",
        rpc_status: status,
        supabase_error: msg,
        supabase_details: details,
      }));
      return errorResponse(appError(
        isJwtError ? 401 : 500,
        isJwtError ? "JWT non valido o scaduto" : "Errore ricerca candidati",
        isJwtError ? "AUTH_INVALID_JWT" : "AI_CANDIDATES_QUERY_FAILED",
        isJwtError ? "Effettua nuovamente il login." : "Riprova tra pochi secondi.",
        details ? `${msg} | ${details}` : msg,
        "analysis",
      ), requestId);
    }

    if (!candidates.length) {
      if (!geminiKey) {
        return errorResponse(appError(
          503,
          "GEMINI_API_KEY non configurata",
          "CONFIG_GEMINI_API_KEY_MISSING",
          "Configura il secret GEMINI_API_KEY nelle Edge Functions.",
          undefined,
          "analysis",
        ), requestId);
      }

      let queryVector: string;
      try {
        const embedding = await callGeminiEmbedding(geminiKey, query);
        queryVector = toVectorLiteral(embedding);
      } catch (e) {
        const providerError = e instanceof Error ? e.message : "Gemini errore sconosciuto";
        return errorResponse(appError(
          503,
          "Provider embedding non disponibile",
          "AI_PROVIDER_UNAVAILABLE",
          "Verifica GEMINI_API_KEY e riprova.",
          providerError,
          "analysis",
        ), requestId);
      }

      try {
        candidates = await callBankAiSearchCandidatesRpc(
          companyId,
          queryVector,
          limit,
          direction,
          dateFrom,
          dateTo,
        );
        console.log(`[vector-search] found ${candidates.length} results for query: ${query}`);
      } catch (e) {
        const status = isRpcErrorPayload(e) ? e.status : 500;
        const msg = isRpcErrorPayload(e) ? e.message : (e instanceof Error ? e.message : "Errore SQL sconosciuto");
        const details = isRpcErrorPayload(e) ? e.details : undefined;
        const isJwtError = status === 401 || status === 403 || /jwt|auth|token|session|expired|invalid/i.test(msg);
        console.error(JSON.stringify({
          request_id: requestId,
          company_id: companyId,
          auth_stage: "bank_ai_search_candidates_vector",
          rpc_status: status,
          supabase_error: msg,
          supabase_details: details,
        }));
        return errorResponse(appError(
          isJwtError ? 401 : 500,
          isJwtError ? "JWT non valido o scaduto" : "Errore ricerca candidati",
          isJwtError ? "AUTH_INVALID_JWT" : "AI_CANDIDATES_QUERY_FAILED",
          isJwtError ? "Effettua nuovamente il login." : "Riprova tra pochi secondi.",
          details ? `${msg} | ${details}` : msg,
          "analysis",
        ), requestId);
      }
    }
    if (!candidates.length) {
      return jsonResponse({
        mode: "analysis" as AiMode,
        answer: "Nessun movimento compatibile trovato con i filtri correnti.",
        candidate_count: 0,
        candidate_ids: [],
        used_count: 0,
        model: "analysis:none",
        request_id: requestId,
      }, requestId, 200);
    }

    const prompt = buildPrompt(query, candidates);
    let answer = "";
    try {
      answer = await callAnthropic(anthropicKey, prompt);
    } catch (e) {
      const providerError = e instanceof Error ? e.message : "Anthropic errore sconosciuto";
      return errorResponse(appError(
        503,
        "Provider AI non disponibile",
        "AI_PROVIDER_UNAVAILABLE",
        "Verifica ANTHROPIC_API_KEY e riprova.",
        providerError,
        "analysis",
      ), requestId);
    }

    return jsonResponse({
      mode: "analysis" as AiMode,
      answer,
      candidate_count: candidates.length,
      candidate_ids: candidates.map((c) => c.id),
      used_count: candidates.length,
      model: `anthropic:${ANTHROPIC_MODEL}`,
      request_id: requestId,
    }, requestId, 200);
  } catch (e) {
    if (isAppErrorPayload(e)) {
      return errorResponse(e, requestId);
    }

    const msg = e instanceof Error ? e.message : "Errore sconosciuto";
    console.error(JSON.stringify({
      request_id: requestId,
      auth_stage: "unhandled",
      supabase_error: msg,
    }));
    return errorResponse(appError(500, "Errore interno bank-ai-search", "INTERNAL_ERROR", "Riprova tra poco.", msg), requestId);
  }
});
