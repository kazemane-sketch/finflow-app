import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUEST_TIMEOUT_MS = Number(Deno.env.get("BANK_AI_SEARCH_TIMEOUT_MS") ?? "30000");
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-20241022";
const GEMINI_TEXT_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";
const GEMINI_EMBEDDING_MODEL = Deno.env.get("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-001";
const MAX_CANDIDATES = 50;
const EXPECTED_EMBEDDING_DIMS = 3072;

type DirectionFilter = "all" | "in" | "out";
type AiMode = "filter" | "analysis";

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
  similarity: number | null;
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

function enrichQueryWithMonthHints(query: string): string {
  const q = query.toLowerCase();
  const monthMap: Record<string, { full: string; num: string }> = {
    gen: { full: "gennaio", num: "01" },
    feb: { full: "febbraio", num: "02" },
    mar: { full: "marzo", num: "03" },
    apr: { full: "aprile", num: "04" },
    mag: { full: "maggio", num: "05" },
    giu: { full: "giugno", num: "06" },
    lug: { full: "luglio", num: "07" },
    ago: { full: "agosto", num: "08" },
    set: { full: "settembre", num: "09" },
    ott: { full: "ottobre", num: "10" },
    nov: { full: "novembre", num: "11" },
    dic: { full: "dicembre", num: "12" },
  };

  const hits: string[] = [];
  for (const [abbr, def] of Object.entries(monthMap)) {
    const rx = new RegExp(`\\b${abbr}\\b`, "i");
    if (rx.test(q)) hits.push(`${def.full} (${def.num})`);
  }

  if (!hits.length) return query;
  return `${query}\nContesto mesi: ${hits.join(", ")}`;
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

async function callGeminiEmbedding(apiKey: string, text: string, taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT"): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini embedding error: ${msg}`);
  }

  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_EMBEDDING_DIMS) {
    throw new Error(`Gemini embedding dimensione inattesa (${Array.isArray(values) ? values.length : "n/a"})`);
  }
  return values.map((v: unknown) => Number(v));
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
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

async function callGeminiText(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2048,
      },
    }),
  }, REQUEST_TIMEOUT_MS);

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini text error: ${msg}`);
  }

  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => typeof p?.text === "string" ? p.text : "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini empty response");
  return text;
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

async function requireCompanyAccess(
  admin: ReturnType<typeof createClient>,
  token: string,
  companyId: string,
): Promise<{ userId: string }> {
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

  return { userId: userData.user.id };
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
  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Supabase non configurato", request_id: requestId }, requestId, 500);
  }

  const token = getBearerToken(req);
  if (!token) {
    return jsonResponse({ error: "Authorization Bearer mancante", request_id: requestId }, requestId, 401);
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
      return jsonResponse({ error: "query obbligatoria", request_id: requestId }, requestId, 400);
    }
    if (!companyId) {
      return jsonResponse({ error: "company_id obbligatorio", request_id: requestId }, requestId, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await requireCompanyAccess(admin, token, companyId);

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

    if (!geminiKey) {
      return jsonResponse({
        error: "GEMINI_API_KEY non configurata",
        mode: "analysis" as AiMode,
        request_id: requestId,
      }, requestId, 503);
    }

    const queryEmbedding = await callGeminiEmbedding(geminiKey, enrichQueryWithMonthHints(query), "RETRIEVAL_QUERY");
    const queryVector = toVectorLiteral(queryEmbedding);

    const { data: candidateData, error: candidateError } = await admin.rpc("bank_ai_search_candidates", {
      p_company_id: companyId,
      p_query_vector: queryVector,
      p_limit: limit,
      p_direction: direction,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    });

    if (candidateError) {
      return jsonResponse({
        error: `Errore ricerca candidati: ${candidateError.message}`,
        mode: "analysis" as AiMode,
        request_id: requestId,
      }, requestId, 500);
    }

    const candidates = (Array.isArray(candidateData) ? candidateData : []) as CandidateTx[];
    if (!candidates.length) {
      return jsonResponse({
        mode: "analysis" as AiMode,
        answer: "Nessun movimento compatibile trovato con i filtri correnti.",
        candidate_count: 0,
        used_count: 0,
        model: "analysis:none",
        request_id: requestId,
      }, requestId, 200);
    }

    const prompt = buildPrompt(query, candidates);
    let answer = "";
    let model = "";
    const providerErrors: string[] = [];

    if (anthropicKey) {
      try {
        answer = await callAnthropic(anthropicKey, prompt);
        model = `anthropic:${ANTHROPIC_MODEL}`;
      } catch (e) {
        providerErrors.push(e instanceof Error ? e.message : "Anthropic errore sconosciuto");
      }
    }

    if (!answer && geminiKey) {
      try {
        answer = await callGeminiText(geminiKey, prompt);
        model = `gemini:${GEMINI_TEXT_MODEL}`;
      } catch (e) {
        providerErrors.push(e instanceof Error ? e.message : "Gemini errore sconosciuto");
      }
    }

    if (!answer) {
      return jsonResponse({
        error: `Nessun provider AI disponibile: ${providerErrors.join(" | ") || "errore sconosciuto"}`,
        mode: "analysis" as AiMode,
        request_id: requestId,
      }, requestId, 503);
    }

    return jsonResponse({
      mode: "analysis" as AiMode,
      answer,
      candidate_count: candidates.length,
      used_count: candidates.length,
      model,
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
    return jsonResponse({ error: msg, request_id: requestId }, requestId, 500);
  }
});
