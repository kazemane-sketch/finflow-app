const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_TRANSACTIONS = Number(Deno.env.get("BANK_AI_SEARCH_MAX_TX") ?? "1500");
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("BANK_AI_SEARCH_TIMEOUT_MS") ?? "30000");
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-20241022";
const GEMINI_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";

type SearchTx = {
  id: string | null;
  date: string | null;
  value_date: string | null;
  amount: number | null;
  description: string;
  counterparty_name: string | null;
  transaction_type: string | null;
  reference: string | null;
  invoice_ref: string | null;
  direction: "in" | "out" | null;
};

function clip(v: unknown, max: number): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeDirection(v: unknown): "in" | "out" | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "in") return "in";
  if (s === "out") return "out";
  return null;
}

function sanitizeTransactions(raw: unknown): SearchTx[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchTx[] = [];
  for (const item of raw) {
    const description = clip(item?.description, 220);
    const counterparty = clip(item?.counterparty_name, 120) || null;
    const reference = clip(item?.reference, 80) || null;
    const invoiceRef = clip(item?.invoice_ref, 40) || null;
    const txType = clip(item?.transaction_type, 40) || null;
    const direction = normalizeDirection(item?.direction);
    const date = clip(item?.date, 20) || null;
    const valueDate = clip(item?.value_date, 20) || null;
    const amount = toNumber(item?.amount);
    const id = clip(item?.id, 64) || null;
    if (!description && amount == null && !counterparty && !reference) continue;
    out.push({
      id,
      date,
      value_date: valueDate,
      amount,
      description,
      counterparty_name: counterparty,
      transaction_type: txType,
      reference,
      invoice_ref: invoiceRef,
      direction,
    });
  }
  return out;
}

function buildPrompt(query: string, txs: SearchTx[]): string {
  return [
    "Sei un assistente contabile che risponde a domande su movimenti bancari.",
    "Usa SOLO i movimenti forniti in input.",
    "Non inventare dati o transazioni mancanti.",
    "Se la richiesta non e' risolvibile con i dati, dillo chiaramente.",
    "Rispondi in italiano, in modo pratico e sintetico.",
    "",
    `Domanda utente: ${query}`,
    "",
    `Movimenti disponibili (${txs.length}):`,
    JSON.stringify(txs),
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

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
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
    throw new Error(`Gemini error: ${msg}`);
  }

  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => typeof p?.text === "string" ? p.text : "")
    .join("\n")
    .trim();
  if (!text) throw new Error("Gemini empty response");
  return text;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const query = clip(body?.query, 500);
    if (!query) {
      return new Response(JSON.stringify({ error: "query obbligatoria" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allTx = sanitizeTransactions(body?.transactions);
    const usedTx = allTx.slice(0, MAX_TRANSACTIONS);
    const truncated = allTx.length > usedTx.length;

    if (!usedTx.length) {
      return new Response(JSON.stringify({
        answer: "Nessun movimento disponibile per l'analisi AI.",
        used_count: 0,
        truncated: false,
        model: "none",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = buildPrompt(query, usedTx);
    const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();

    let answer = "";
    let model = "";
    const providerErrors: string[] = [];

    if (anthropicKey) {
      try {
        answer = await callAnthropic(anthropicKey, prompt);
        model = `anthropic:${ANTHROPIC_MODEL}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Anthropic errore sconosciuto";
        providerErrors.push(msg);
      }
    }

    if (!answer && geminiKey) {
      try {
        answer = await callGemini(geminiKey, prompt);
        model = `gemini:${GEMINI_MODEL}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Gemini errore sconosciuto";
        providerErrors.push(msg);
      }
    }

    if (!answer) {
      const reason = !anthropicKey && !geminiKey
        ? "AI provider non configurato (manca ANTHROPIC_API_KEY o GEMINI_API_KEY)."
        : `Nessun provider AI disponibile: ${providerErrors.join(" | ") || "errore sconosciuto"}`;

      return new Response(JSON.stringify({
        answer: `Servizio AI temporaneamente non disponibile.\n${reason}`,
        used_count: usedTx.length,
        truncated,
        model: "fallback:unavailable",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!model) {
      return new Response(JSON.stringify({
        answer: "Servizio AI disponibile ma senza modello identificato. Riprovare tra poco.",
        used_count: usedTx.length,
        truncated,
        model: "fallback:unknown-model",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      answer,
      used_count: usedTx.length,
      truncated,
      model,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Errore sconosciuto";
    return new Response(JSON.stringify({
      answer: `Servizio AI temporaneamente non disponibile.\n${msg}`,
      used_count: 0,
      truncated: false,
      model: "fallback:exception",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
