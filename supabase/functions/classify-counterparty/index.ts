const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type LegalType = "azienda" | "pa" | "professionista" | "persona" | "altro";
type SourceType = "rule" | "ai";

const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-latest";
const GEMINI_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("COUNTERPARTY_AI_TIMEOUT_MS") ?? "12000");

const PA_KEYWORDS = [
  "comune", "ministero", "regione", "provincia", "asl", "azienda sanitaria", "universita",
  "istituto comprensivo", "ente", "agenzia delle entrate", "inps", "inail", "camera di commercio",
];

const PROFESSIONAL_KEYWORDS = [
  "studio", "avv", "avvocato", "dott", "commercialista", "consulente", "ing", "arch", "notaio", "geometra",
];

const COMPANY_KEYWORDS = [
  "srl", "spa", "snc", "sas", "sapa", "srls", "societa", "cooperativa", "consorzio", "impresa",
];

const PERSONA_REGEX = /^[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'`.-]+\s+[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'`.-]+$/i;

function clip(v: unknown, max = 250): string {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeVat(vat: string): string {
  return vat.toUpperCase().replace(/^IT/, "").replace(/[^A-Z0-9]/g, "").trim();
}

function normalizeCf(cf: string): string {
  return cf.toUpperCase().replace(/[^A-Z0-9]/g, "").trim();
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function inferByRules(payload: {
  name: string;
  vat_number?: string;
  fiscal_code?: string;
}): { legal_type: LegalType; confidence: number; source: SourceType } {
  const name = clip(payload.name, 160).toLowerCase();
  const vat = normalizeVat(clip(payload.vat_number, 40));
  const cf = normalizeCf(clip(payload.fiscal_code, 40));

  if (!name) return { legal_type: "altro", confidence: 0.35, source: "rule" };
  if (PA_KEYWORDS.some((k) => name.includes(k))) return { legal_type: "pa", confidence: 0.93, source: "rule" };
  if (PROFESSIONAL_KEYWORDS.some((k) => name.includes(k))) return { legal_type: "professionista", confidence: 0.83, source: "rule" };
  if (PERSONA_REGEX.test(name) && cf.length === 16 && !vat) return { legal_type: "persona", confidence: 0.8, source: "rule" };
  if (vat && (vat.length === 11 || COMPANY_KEYWORDS.some((k) => name.includes(k)))) return { legal_type: "azienda", confidence: 0.76, source: "rule" };
  if (!vat && cf.length === 16) return { legal_type: "persona", confidence: 0.64, source: "rule" };
  return { legal_type: "altro", confidence: 0.45, source: "rule" };
}

function parseAiJson(text: string): { legal_type: LegalType; confidence: number } | null {
  const allowed: LegalType[] = ["azienda", "pa", "professionista", "persona", "altro"];
  const raw = text.trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!allowed.includes(parsed?.legal_type)) return null;
    const conf = Math.max(0, Math.min(1, safeNum(parsed?.confidence, 0)));
    return { legal_type: parsed.legal_type, confidence: Math.round(conf * 100) / 100 };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      if (!allowed.includes(parsed?.legal_type)) return null;
      const conf = Math.max(0, Math.min(1, safeNum(parsed?.confidence, 0)));
      return { legal_type: parsed.legal_type, confidence: Math.round(conf * 100) / 100 };
    } catch {
      return null;
    }
  }
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
      temperature: 0,
      max_tokens: 350,
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
        maxOutputTokens: 350,
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

function buildPrompt(payload: {
  name: string;
  vat_number?: string;
  fiscal_code?: string;
  address?: string;
  source_context?: string;
}): string {
  return [
    "Classifica questa controparte italiana in una sola categoria:",
    "- azienda",
    "- pa",
    "- professionista",
    "- persona",
    "- altro",
    "",
    "Rispondi SOLO JSON valido:",
    '{"legal_type":"azienda|pa|professionista|persona|altro","confidence":0.0}',
    "",
    `name: ${clip(payload.name, 180)}`,
    `vat_number: ${clip(payload.vat_number, 40) || ""}`,
    `fiscal_code: ${clip(payload.fiscal_code, 40) || ""}`,
    `address: ${clip(payload.address, 180) || ""}`,
    `source_context: ${clip(payload.source_context, 60) || ""}`,
  ].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const name = clip(body?.name, 180);
    const vat_number = clip(body?.vat_number, 40);
    const fiscal_code = clip(body?.fiscal_code, 40);
    const address = clip(body?.address, 200);
    const source_context = clip(body?.source_context, 60);

    if (!name) {
      return new Response(JSON.stringify({ error: "name obbligatorio" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rule = inferByRules({ name, vat_number, fiscal_code });
    if (rule.confidence >= 0.74) {
      return new Response(JSON.stringify(rule), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = buildPrompt({ name, vat_number, fiscal_code, address, source_context });
    const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();

    if (!anthropicKey && !geminiKey) {
      return new Response(JSON.stringify(rule), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let answer = "";
    if (anthropicKey) answer = await callAnthropic(anthropicKey, prompt);
    else answer = await callGemini(geminiKey, prompt);

    const parsed = parseAiJson(answer);
    if (!parsed) {
      return new Response(JSON.stringify(rule), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const confidence = Math.max(parsed.confidence, rule.confidence);
    return new Response(JSON.stringify({
      legal_type: parsed.legal_type,
      confidence,
      source: "ai",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Errore sconosciuto";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
