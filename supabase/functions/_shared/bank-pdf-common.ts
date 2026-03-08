// supabase/functions/_shared/bank-pdf-common.ts
// Shared utilities, types, and constants for bank PDF parsers.
// Used by: parse-bank-pdf, parse-bank-pdf-ocr, parse-bank-pdf-plumber.

// ── CORS ──────────────────────────────────────────────────────────────
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Types ─────────────────────────────────────────────────────────────
export type PostingSide = "dare" | "avere" | "unknown";
export type Direction = "in" | "out";
export type DirectionSource = "side_rule" | "semantic_rule" | "amount_fallback" | "manual";
export type AmountSignExplicit = "minus" | "plus_or_none" | "unknown";
export type SemanticKeyword = { needle: string; weight: number };

export type DirectionInference = {
  direction: Direction;
  source: DirectionSource;
  confidence: number;
  needsReview: boolean;
  reason: string;
};

export type SideSource = "explicit" | "inferred" | "unknown";

// ── Keyword lists (superset from all parsers) ─────────────────────────
export const OUT_KEYWORDS: SemanticKeyword[] = [
  { needle: "vostra disposizione a favore", weight: 2.8 },
  { needle: "bonifico a favore", weight: 2.4 },
  { needle: "addebito", weight: 2.3 },
  { needle: "effetti ritirati pagati", weight: 2.7 },
  { needle: "effetti ritirati", weight: 1.8 },
  { needle: "f24", weight: 2.4 },
  { needle: "commissioni", weight: 1.7 },
  { needle: "commissione", weight: 1.6 },
  { needle: "rid", weight: 1.8 },
  { needle: "sdd", weight: 1.8 },
  { needle: "prelievo", weight: 2.2 },
  { needle: "pagamento", weight: 1.4 },
  { needle: "assegno", weight: 1.5 },
  { needle: "giroconto", weight: 1.2 },
  { needle: "disposizione filiale disponente", weight: 2.0 },
];

export const IN_KEYWORDS: SemanticKeyword[] = [
  { needle: "a vostro favore", weight: 2.8 },
  { needle: "bonifico a vostro favore", weight: 2.8 },
  { needle: "accredito", weight: 2.2 },
  { needle: "stipendio", weight: 2.2 },
  { needle: "interessi a credito", weight: 2.6 },
  { needle: "interessi creditori", weight: 2.2 },
  { needle: "incasso", weight: 1.8 },
  { needle: "versamento", weight: 1.8 },
  { needle: "rimborso", weight: 1.5 },
  { needle: "riaccredito", weight: 2.2 },
  { needle: "saldo a credito", weight: 2.0 },
];

// ── SSE streaming ─────────────────────────────────────────────────────
export function sseData(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) {
  const enc = new TextEncoder();
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
}

// ── Utilities ─────────────────────────────────────────────────────────
export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const normalized = s
    .replace(/\s/g, "")
    .replace(/[€]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".")
    .replace(/[^0-9+-.]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function normalizeText(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[^a-z0-9àèéìòù\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function roundConfidence(v: number): number {
  const bounded = Math.min(1, Math.max(0, v));
  return Math.round(bounded * 100) / 100;
}

export function normType(v: unknown): string {
  const allowed = new Set([
    "bonifico_in",
    "bonifico_out",
    "riba",
    "sdd",
    "pos",
    "prelievo",
    "commissione",
    "stipendio",
    "f24",
    "altro",
  ]);
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return allowed.has(t) ? t : "altro";
}

export function detectExplicitAmountSign(amountTextRaw: string | null): AmountSignExplicit {
  if (!amountTextRaw) return "unknown";
  const s = amountTextRaw.trim();
  if (!s) return "unknown";
  if (/^[\s]*-/.test(s) || /^[\s]*\(/.test(s)) return "minus";
  return "plus_or_none";
}

export function normalizePostingSide(v: unknown): PostingSide {
  const s = normalizeText(v);
  if (!s) return "unknown";

  if (
    s === "d" ||
    s === "dare" ||
    s.includes("mov dare") ||
    s.includes("movimento dare") ||
    s.includes("colonna dare")
  ) return "dare";

  if (
    s === "a" ||
    s === "avere" ||
    s.includes("mov avere") ||
    s.includes("movimento avere") ||
    s.includes("colonna avere")
  ) return "avere";

  return "unknown";
}

// ── Direction inference ───────────────────────────────────────────────
export function scoreKeywords(text: string, rules: SemanticKeyword[]): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];
  for (const rule of rules) {
    if (text.includes(rule.needle)) {
      score += rule.weight;
      hits.push(rule.needle);
    }
  }
  return { score, hits };
}

export function expectedDirectionFromType(txType: string): Direction | null {
  switch (txType) {
    case "bonifico_in":
    case "stipendio":
      return "in";
    case "bonifico_out":
    case "sdd":
    case "pos":
    case "prelievo":
    case "commissione":
    case "f24":
      return "out";
    default:
      return null;
  }
}

// ── JSON parsing ──────────────────────────────────────────────────────
export function normalizePayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.transactions)) return payload.transactions;
  if (payload && Array.isArray(payload.movimenti)) return payload.movimenti;
  if (payload?.data && Array.isArray(payload.data.transactions)) return payload.data.transactions;
  if (payload?.result && Array.isArray(payload.result.transactions)) return payload.result.transactions;
  return [];
}

export function tryParseAnyJson(text: string): any[] {
  const s = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!s) return [];

  try {
    return normalizePayload(JSON.parse(s));
  } catch {
    // continue
  }

  const arrayStart = s.indexOf("[");
  const arrayEnd = s.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return normalizePayload(JSON.parse(s.slice(arrayStart, arrayEnd + 1)));
    } catch {
      // continue
    }
  }

  const objStart = s.indexOf("{");
  const objEnd = s.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return normalizePayload(JSON.parse(s.slice(objStart, objEnd + 1)));
    } catch {
      // continue
    }
  }

  const lastComplete = s.lastIndexOf("},");
  if (lastComplete > 0) {
    const candidate = `${s.slice(0, lastComplete + 1)}]`;
    try {
      return normalizePayload(JSON.parse(candidate));
    } catch {
      // continue
    }
  }

  return [];
}
