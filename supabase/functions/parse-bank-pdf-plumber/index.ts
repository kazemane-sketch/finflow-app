import { PDFDocument } from "npm:pdf-lib";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHUNK_SIZE = Number(Deno.env.get("PDF_PLUMBER_CHUNK_PAGES") ?? Deno.env.get("PDF_CHUNK_PAGES") ?? "6");
const PARSER_TIMEOUT_MS = Number(Deno.env.get("PDF_PARSER_TIMEOUT_MS") ?? "120000");
const GEMINI_TEXT_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";
const GEMINI_TEXT_TIMEOUT_MS = Number(Deno.env.get("GEMINI_TEXT_TIMEOUT_MS") ?? "8000");
const LLM_ENRICH_BATCH_SIZE = 20;
const DESCRIPTION_CONFIDENCE_THRESHOLD = 0.6;
const COUNTERPARTY_CONFIDENCE_THRESHOLD = 0.7;

type PostingSide = "dare" | "avere" | "unknown";
type Direction = "in" | "out";
type DirectionSource = "side_rule" | "semantic_rule" | "amount_fallback" | "manual";
type AmountSignExplicit = "minus" | "plus_or_none" | "unknown";
type CounterpartySource = "regex" | "heuristic" | "llm" | "parser_seed" | "unknown";
type DescriptionSource = "llm" | "parser_fallback";
type RawIntegrity = "complete" | "suspect";

type Tx = {
  date: string;
  value_date: string | null;
  amount: number;
  commission: number | null;
  description: string;
  counterparty_name: string | null;
  transaction_type: string;
  reference: string | null;
  invoice_ref: string | null;
  category_code: string | null;
  raw_text: string | null;
  amount_text: string | null;
  amount_sign_explicit: AmountSignExplicit;
  posting_side: PostingSide;
  direction: Direction;
  direction_source: DirectionSource;
  direction_confidence: number;
  direction_needs_review: boolean;
  direction_reason: string;
  description_source: DescriptionSource;
  description_confidence: number;
  counterparty_source: CounterpartySource;
  counterparty_confidence: number;
  counterparty_needs_review: boolean;
  parser_description: string;
  parser_counterparty_name: string | null;
  raw_integrity: RawIntegrity;
  raw_integrity_reason: string | null;
  start_page: number | null;
  summary_reason?: string | null;
};

type LlmEnrichmentItem = {
  index: number;
  short_description: string | null;
  counterparty_name: string | null;
  confidence_description: number;
  confidence_counterparty: number;
};

type ParserTx = {
  date?: unknown;
  value_date?: unknown;
  amount_abs?: unknown;
  amount_text?: unknown;
  posting_side?: unknown;
  description?: unknown;
  raw_text?: unknown;
  reference?: unknown;
  category_code?: unknown;
  transaction_type?: unknown;
  counterparty_name?: unknown;
  counterparty_source?: unknown;
  counterparty_confidence?: unknown;
  column_confidence?: unknown;
  qc_needs_review?: unknown;
  row_reason?: unknown;
  raw_integrity?: unknown;
  raw_integrity_reason?: unknown;
  start_page?: unknown;
  page?: unknown;
};

type ParserSummaryRow = ParserTx;

type ParserStatement = {
  opening_balance?: unknown;
  closing_balance?: unknown;
  closing_date?: unknown;
};

type ParserResponse = {
  transactions?: ParserTx[];
  summary_rows?: ParserSummaryRow[];
  statement?: ParserStatement;
  stats?: {
    pages_processed?: unknown;
    rows_detected?: unknown;
    rows_unknown_side?: unknown;
    parse_errors?: unknown;
    summary_rows_detected?: unknown;
  };
  quality?: {
    qc_fail_count?: unknown;
    ledger_match?: unknown;
    anomalies?: unknown;
  };
  range?: {
    start_page?: unknown;
    end_page?: unknown;
    total_pages?: unknown;
  };
};

type DirectionDecision = {
  direction: Direction;
  source: DirectionSource;
  confidence: number;
  needsReview: boolean;
  reason: string;
};

type Keyword = { needle: string; weight: number };

const OUT_KEYWORDS: Keyword[] = [
  { needle: "vostra disposizione a favore", weight: 2.8 },
  { needle: "bonifico a favore", weight: 2.4 },
  { needle: "addebito", weight: 2.3 },
  { needle: "effetti ritirati", weight: 2.5 },
  { needle: "f24", weight: 2.4 },
  { needle: "commissioni", weight: 1.7 },
  { needle: "rid", weight: 1.8 },
  { needle: "sdd", weight: 1.8 },
  { needle: "prelievo", weight: 2.1 },
  { needle: "pagamento", weight: 1.4 },
];

const IN_KEYWORDS: Keyword[] = [
  { needle: "a vostro favore", weight: 2.8 },
  { needle: "accredito", weight: 2.2 },
  { needle: "stipendio", weight: 2.2 },
  { needle: "interessi a credito", weight: 2.6 },
  { needle: "incasso", weight: 1.8 },
  { needle: "versamento", weight: 1.7 },
  { needle: "rimborso", weight: 1.5 },
];

const INVALID_COUNTERPARTY_VALUES = new Set([
  "",
  "n.d.",
  "n.d",
  "nd",
  "n/d",
  "(per",
  "per",
  "ordine e conto",
  "ordine",
  "conto",
  "bonifico",
  "filiale",
  "bic",
  "inf",
  "ri",
  "rif",
  "num",
  "tot",
  "importo",
]);

const COUNTERPARTY_STOP_MARKERS = [
  "bonifico per ordine/conto",
  "bonifico per",
  "filiale disponente",
  "id flusso cbi",
  "bic:",
  "inf:",
  "ri:",
  "rif.",
  "num.",
  "tot.",
  "importo",
  "ord.orig",
  "caus:",
];

function sseData(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) {
  const enc = new TextEncoder();
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function roundConfidence(v: number): number {
  const bounded = Math.min(1, Math.max(0, v));
  return round2(bounded);
}

function toNumber(v: unknown): number | null {
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

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function normalizeText(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[^a-z0-9àèéìòù\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCounterpartySource(v: unknown): CounterpartySource {
  const s = normalizeText(v);
  if (s === "regex") return "regex";
  if (s === "heuristic") return "heuristic";
  if (s === "llm") return "llm";
  if (s === "parser_seed") return "parser_seed";
  return "unknown";
}

function cleanCounterpartyName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let name = v.trim();
  if (!name) return null;
  name = name.replace(/^[\s(]*per\b/i, "").trim();
  name = name.replace(/^\(?\s*ordine\s+e\s+conto\)?/i, "").trim();
  name = name.replace(/^\s*a\s+favore\s+di\s+/i, "").trim();
  name = name.replace(/^\s*bonifico\s+a\s+vostro\s+favore\s*/i, "").trim();
  for (const marker of COUNTERPARTY_STOP_MARKERS) {
    const idx = name.toLowerCase().indexOf(marker);
    if (idx > 0) {
      name = name.slice(0, idx).trim();
      break;
    }
  }
  name = name.replace(/\s+/g, " ").replace(/^[-:;,. ]+|[-:;,. ]+$/g, "").trim();
  if (!name) return null;
  if (name.length < 3 || name.length > 120) return null;
  return name;
}

function cleanShortDescription(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let text = v.trim();
  if (!text) return null;
  text = text
    .replace(/^[\s()[\]{}\-–—:;,.]+/, "")
    .replace(/^\(\s*[a-z0-9\s/.,-]*\)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  for (const marker of COUNTERPARTY_STOP_MARKERS) {
    const idx = text.toLowerCase().indexOf(marker);
    if (idx > 0) {
      text = text.slice(0, idx).trim();
      break;
    }
  }
  text = text.replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > 70) text = text.slice(0, 70).trim();
  if (text.length < 4) return null;
  const low = text.toLowerCase();
  if (INVALID_COUNTERPARTY_VALUES.has(low) || INVALID_COUNTERPARTY_VALUES.has(low.replace(/[^a-z0-9]/g, ""))) {
    return null;
  }
  return text;
}

function cleanParserFallbackDescription(v: unknown): string {
  const raw = typeof v === "string" ? v : String(v ?? "");
  const compact = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = cleanShortDescription(compact);
  if (cleaned) return cleaned;
  if (!compact) return "Movimento bancario";
  return compact.length > 90 ? `${compact.slice(0, 90).trim()}…` : compact;
}

function isInvalidCounterparty(name: string | null | undefined): boolean {
  const cleaned = cleanCounterpartyName(name);
  if (!cleaned) return true;
  const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return true;
  if (INVALID_COUNTERPARTY_VALUES.has(cleaned.toLowerCase())) return true;
  if (INVALID_COUNTERPARTY_VALUES.has(normalized)) return true;

  const parts = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length <= 2 && parts.every((p) => INVALID_COUNTERPARTY_VALUES.has(p))) return true;
  return false;
}

function counterpartyCanUseLlm(txType: string): boolean {
  return txType === "bonifico_in" ||
    txType === "bonifico_out" ||
    txType === "riba" ||
    txType === "sdd" ||
    txType === "altro";
}

function detectExplicitAmountSign(amountTextRaw: string | null): AmountSignExplicit {
  if (!amountTextRaw) return "unknown";
  const s = amountTextRaw.trim();
  if (!s) return "unknown";
  if (/^[\s]*-/.test(s) || /^[\s]*\(/.test(s)) return "minus";
  return "plus_or_none";
}

function normalizePostingSide(v: unknown): PostingSide {
  const s = normalizeText(v);
  if (!s) return "unknown";
  if (s === "dare" || s.includes("dare") || s === "d") return "dare";
  if (s === "avere" || s.includes("avere") || s === "a") return "avere";
  return "unknown";
}

function normalizeRawIntegrity(v: unknown): RawIntegrity {
  const s = normalizeText(v);
  return s === "suspect" ? "suspect" : "complete";
}

function normType(v: unknown): string {
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

function scoreKeywords(text: string, rules: Keyword[]): { score: number; hits: string[] } {
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

function expectedDirectionFromType(txType: string): Direction | null {
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

function inferTypeByText(text: string, direction: Direction): string {
  const t = normalizeText(text);
  if (t.includes("f24")) return "f24";
  if (t.includes("stipend")) return "stipendio";
  if (t.includes("rid") || t.includes("sdd")) return "sdd";
  if (t.includes("preliev")) return "prelievo";
  if (t.includes("commission")) return "commissione";
  if (t.includes("riba") || t.includes("effetti ritirati")) return "riba";
  if (t.includes("bonific") || t.includes("disposizione")) return direction === "in" ? "bonifico_in" : "bonifico_out";
  return "altro";
}

function inferDirectionSemantic(text: string, txType: string): DirectionDecision {
  const inScore = scoreKeywords(text, IN_KEYWORDS);
  const outScore = scoreKeywords(text, OUT_KEYWORDS);

  let direction: Direction = "in";
  let confidence = 0.56;
  let reason = "Fallback amount_fallback: colonna non riconosciuta";
  let source: DirectionSource = "amount_fallback";

  if (inScore.score > 0 || outScore.score > 0) {
    direction = outScore.score > inScore.score ? "out" : "in";
    const diff = Math.abs(outScore.score - inScore.score);
    confidence = diff >= 2 ? 0.88 : diff >= 1 ? 0.78 : 0.66;
    source = "semantic_rule";
    const hits = direction === "out" ? outScore.hits : inScore.hits;
    reason = `Regola semantica: ${hits.slice(0, 3).join(", ") || "keyword"}`;
  }

  if (source === "amount_fallback") {
    const expected = expectedDirectionFromType(txType);
    if (expected) {
      direction = expected;
      confidence = 0.6;
      source = "semantic_rule";
      reason = `Fallback da transaction_type=${txType}`;
    }
  }

  return {
    direction,
    source,
    confidence: roundConfidence(confidence),
    needsReview: true,
    reason,
  };
}

function extractCommission(rawText: string): number | null {
  const match = rawText.match(/importo\s+commissioni\s*:?\s*([0-9.,]+)/i) ||
    rawText.match(/commissioni\s*:?\s*([0-9.,]+)/i) ||
    rawText.match(/commissione\s*:?\s*([0-9.,]+)/i);
  if (!match) return null;
  const num = toNumber(match[1]);
  if (num == null) return null;
  return Math.abs(num);
}

function mapParserTx(item: ParserTx): Tx | null {
  const date = clip(item?.date, 20);
  const amountAbsNum = toNumber(item?.amount_abs);
  if (!date || amountAbsNum == null) return null;

  const postingSide = normalizePostingSide(item?.posting_side);
  const amountText = clip(item?.amount_text, 80);
  const amountSignExplicit = detectExplicitAmountSign(amountText);

  const parserDescriptionRaw = clip(item?.description, 600) ?? "";
  const parserDescription = cleanParserFallbackDescription(parserDescriptionRaw);
  const rawTextInput = typeof item?.raw_text === "string" ? item.raw_text.trim() : "";
  const rawText = rawTextInput || parserDescriptionRaw;
  const reference = clip(item?.reference, 120);
  const categoryCode = clip(item?.category_code, 40);
  const rawIntegrity = normalizeRawIntegrity(item?.raw_integrity);
  const rawIntegrityReason = clip(item?.raw_integrity_reason, 160);
  const startPageRaw = toNumber(item?.start_page) ?? toNumber(item?.page);
  const startPage = startPageRaw != null && Number.isFinite(startPageRaw) ? Math.floor(startPageRaw) : null;

  let decision: DirectionDecision;
  if (postingSide === "dare") {
    decision = {
      direction: "out",
      source: "side_rule",
      confidence: 0.98,
      needsReview: false,
      reason: "Regola DARE applicata",
    };
  } else if (postingSide === "avere") {
    decision = {
      direction: "in",
      source: "side_rule",
      confidence: 0.98,
      needsReview: false,
      reason: "Regola AVERE applicata",
    };
  } else {
    decision = inferDirectionSemantic(normalizeText(`${parserDescription} ${rawText} ${reference ?? ""}`), "altro");
    decision.needsReview = true;
  }

  let txType = normType(item?.transaction_type);
  if (txType === "altro") {
    txType = inferTypeByText(`${parserDescription} ${rawText}`, decision.direction);
  }

  const parserCounterparty = cleanCounterpartyName(item?.counterparty_name);
  const parserCounterpartySource = normalizeCounterpartySource(item?.counterparty_source);
  const parserCounterpartyConfidenceRaw = toNumber(item?.counterparty_confidence);
  const parserCounterpartyConfidence = parserCounterparty
    ? roundConfidence(
      parserCounterpartyConfidenceRaw ??
        (parserCounterpartySource === "regex" ? 0.92 : parserCounterpartySource === "heuristic" ? 0.75 : 0),
    )
    : 0;
  const counterpartyInvalid = isInvalidCounterparty(parserCounterparty);
  const counterpartyName = counterpartyInvalid ? "N.D." : (parserCounterparty as string);
  const counterpartyNeedsReview = counterpartyInvalid && counterpartyCanUseLlm(txType);

  const expected = expectedDirectionFromType(txType);
  if (expected && expected !== decision.direction) {
    decision = {
      ...decision,
      confidence: roundConfidence(Math.min(decision.confidence, 0.69)),
      needsReview: true,
      reason: `${decision.reason}; conflitto con transaction_type=${txType}`,
    };
  }

  const columnConfidence = toNumber(item?.column_confidence);
  if (postingSide === "unknown" || (columnConfidence != null && columnConfidence < 0.8)) {
    decision = {
      ...decision,
      confidence: roundConfidence(Math.min(decision.confidence, 0.74)),
      needsReview: true,
      reason: postingSide === "unknown"
        ? `${decision.reason}; colonna DARE/AVERE non riconosciuta`
        : `${decision.reason}; confidenza colonna bassa (${round2(columnConfidence ?? 0)})`,
    };
  }

  if (item?.qc_needs_review === true) {
    decision = {
      ...decision,
      confidence: roundConfidence(Math.min(decision.confidence, 0.72)),
      needsReview: true,
      reason: `${decision.reason}; flagged by parser QC`,
    };
  }

  const amountAbs = Math.abs(amountAbsNum);
  const amount = decision.direction === "in" ? amountAbs : -amountAbs;

  const commission = extractCommission(rawText);

  return {
    date,
    value_date: clip(item?.value_date, 20),
    amount,
    commission,
    description: parserDescription,
    counterparty_name: counterpartyName,
    transaction_type: txType,
    reference,
    invoice_ref: null,
    category_code: categoryCode,
    raw_text: rawText,
    amount_text: amountText,
    amount_sign_explicit: amountSignExplicit,
    posting_side: postingSide,
    direction: decision.direction,
    direction_source: decision.source,
    direction_confidence: decision.confidence,
    direction_needs_review: decision.needsReview,
    direction_reason: clip(decision.reason, 240) || "Direzione determinata automaticamente",
    description_source: "parser_fallback",
    description_confidence: 0.5,
    counterparty_source: counterpartyInvalid ? "unknown" : "parser_seed",
    counterparty_confidence: counterpartyInvalid ? 0 : parserCounterpartyConfidence,
    counterparty_needs_review: counterpartyNeedsReview,
    parser_description: parserDescription,
    parser_counterparty_name: counterpartyInvalid ? null : parserCounterparty,
    raw_integrity: rawIntegrity,
    raw_integrity_reason: rawIntegrityReason,
    start_page: startPage,
    summary_reason: clip(item?.row_reason, 120),
  };
}

function parseAnyJson(raw: string): any {
  const s = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // continue
  }
  const startObj = s.indexOf("{");
  const endObj = s.lastIndexOf("}");
  if (startObj >= 0 && endObj > startObj) {
    try {
      return JSON.parse(s.slice(startObj, endObj + 1));
    } catch {
      // continue
    }
  }
  const startArr = s.indexOf("[");
  const endArr = s.lastIndexOf("]");
  if (startArr >= 0 && endArr > startArr) {
    try {
      return JSON.parse(s.slice(startArr, endArr + 1));
    } catch {
      // continue
    }
  }
  return null;
}

async function callGeminiEnrichmentBatch(
  apiKey: string,
  batch: Array<{
    index: number;
    raw_text: string;
    transaction_type: string;
    direction: Direction;
    posting_side: PostingSide;
    parser_description: string;
    parser_counterparty: string | null;
  }>,
): Promise<LlmEnrichmentItem[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;
  const prompt = [
    "Sei un assistente per normalizzazione movimenti bancari italiani.",
    "Analizza ogni item usando SOLO raw_text.",
    "Per ogni item restituisci:",
    '- short_description: descrizione molto breve e compatta (max 70 char), senza parentesi spurie/codici tecnici.',
    "- counterparty_name: nome persona/societa senza indirizzo, oppure N.D. se non chiaro.",
    "- confidence_description: numero 0..1",
    "- confidence_counterparty: numero 0..1",
    "Regole:",
    "- Non inventare dati non presenti nel testo.",
    "- Niente indirizzi o codici in counterparty_name.",
    "- Se dubbio controparte: N.D. con confidenza bassa.",
    "Rispondi SOLO JSON valido con formato:",
    '{"results":[{"index":0,"short_description":"testo breve","counterparty_name":"NOME o N.D.","confidence_description":0.0,"confidence_counterparty":0.0}]}',
    "",
    JSON.stringify({ items: batch }),
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TEXT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const rawErr = await response.text();
      throw new Error(`Gemini enrich HTTP ${response.status}: ${rawErr.slice(0, 180)}`);
    }
    const payload = await response.json();
    const text = (payload?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => typeof p?.text === "string" ? p.text : "")
      .join("\n")
      .trim();
    const parsed = parseAnyJson(text);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];

    const out: LlmEnrichmentItem[] = [];
    for (const item of arr) {
      const idx = Number(item?.index);
      if (!Number.isFinite(idx)) continue;
      const shortDescription = cleanShortDescription(item?.short_description);
      const counterpartyNameRaw = cleanCounterpartyName(item?.counterparty_name);
      const counterpartyName = (counterpartyNameRaw && !isInvalidCounterparty(counterpartyNameRaw))
        ? counterpartyNameRaw
        : null;
      const confidenceDescription = roundConfidence(toNumber(item?.confidence_description) ?? 0);
      const confidenceCounterparty = roundConfidence(toNumber(item?.confidence_counterparty) ?? 0);
      out.push({
        index: Math.floor(idx),
        short_description: shortDescription,
        counterparty_name: counterpartyName,
        confidence_description: confidenceDescription,
        confidence_counterparty: confidenceCounterparty,
      });
    }
    return out;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Gemini enrich timeout dopo ${Math.round(GEMINI_TEXT_TIMEOUT_MS / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichTransactionsWithLlm(
  apiKey: string,
  transactions: Tx[],
): Promise<{
  llmDescriptionAttemptedCount: number;
  llmDescriptionResolvedCount: number;
  counterpartyAttemptedCount: number;
  counterpartyResolvedCount: number;
  counterpartyReviewCount: number;
  llmBatchFailCount: number;
  warnings: string[];
}> {
  if (!transactions.length) {
    return {
      llmDescriptionAttemptedCount: 0,
      llmDescriptionResolvedCount: 0,
      counterpartyAttemptedCount: 0,
      counterpartyResolvedCount: 0,
      counterpartyReviewCount: 0,
      llmBatchFailCount: 0,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let llmDescriptionAttemptedCount = 0;
  let llmDescriptionResolvedCount = 0;
  let counterpartyAttemptedCount = 0;
  let counterpartyResolvedCount = 0;
  let llmBatchFailCount = 0;
  const failedIndices = new Set<number>();

  for (let start = 0; start < transactions.length; start += LLM_ENRICH_BATCH_SIZE) {
    const slice = transactions.slice(start, start + LLM_ENRICH_BATCH_SIZE);
    const batch = slice.map((tx, localIdx) => ({
      index: start + localIdx,
      raw_text: tx.raw_text || tx.parser_description || "",
      transaction_type: tx.transaction_type || "altro",
      direction: tx.direction,
      posting_side: tx.posting_side,
      parser_description: tx.parser_description || "",
      parser_counterparty: tx.parser_counterparty_name || null,
    }));

    llmDescriptionAttemptedCount += batch.length;
    counterpartyAttemptedCount += batch.length;

    let result: LlmEnrichmentItem[] = [];
    let lastErr: string | null = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await callGeminiEnrichmentBatch(apiKey, batch);
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = String(e?.message || e || "Errore enrichment LLM");
        if (attempt < 2) await delay(300);
      }
    }

    if (lastErr) {
      llmBatchFailCount++;
      for (const item of batch) failedIndices.add(item.index);
      warnings.push(`LLM enrichment batch ${Math.floor(start / LLM_ENRICH_BATCH_SIZE) + 1}: ${lastErr}`);
      continue;
    }

    const byIndex = new Map<number, LlmEnrichmentItem>();
    for (const item of result) {
      if (!Number.isFinite(item.index)) continue;
      byIndex.set(item.index, item);
    }

    for (const item of batch) {
      const tx = transactions[item.index];
      if (!tx) continue;

      const llmItem = byIndex.get(item.index);

      const descCandidate = cleanShortDescription(llmItem?.short_description);
      const descConfidence = roundConfidence(llmItem?.confidence_description ?? 0);
      if (descCandidate && descConfidence >= DESCRIPTION_CONFIDENCE_THRESHOLD) {
        tx.description = descCandidate;
        tx.description_source = "llm";
        tx.description_confidence = descConfidence;
        llmDescriptionResolvedCount++;
      } else {
        tx.description = cleanParserFallbackDescription(tx.parser_description || tx.description || tx.raw_text || "");
        tx.description_source = "parser_fallback";
        tx.description_confidence = 0.5;
      }

      const cpCandidate = cleanCounterpartyName(llmItem?.counterparty_name);
      const cpConfidence = roundConfidence(llmItem?.confidence_counterparty ?? 0);
      if (cpCandidate && !isInvalidCounterparty(cpCandidate) && cpConfidence >= COUNTERPARTY_CONFIDENCE_THRESHOLD) {
        tx.counterparty_name = cpCandidate;
        tx.counterparty_source = "llm";
        tx.counterparty_confidence = cpConfidence;
        tx.counterparty_needs_review = false;
        counterpartyResolvedCount++;
      } else {
        tx.counterparty_name = "N.D.";
        tx.counterparty_source = "unknown";
        tx.counterparty_confidence = 0;
        tx.counterparty_needs_review = counterpartyCanUseLlm(tx.transaction_type);
      }
    }
  }

  for (let idx = 0; idx < transactions.length; idx++) {
    const tx = transactions[idx];

    if (!tx.description || tx.description_source !== "llm") {
      tx.description = cleanParserFallbackDescription(tx.parser_description || tx.description || tx.raw_text || "");
      tx.description_source = "parser_fallback";
      tx.description_confidence = tx.description_confidence || 0.5;
    } else {
      const cleanedDesc = cleanShortDescription(tx.description);
      if (cleanedDesc) tx.description = cleanedDesc;
    }

    if (failedIndices.has(idx)) {
      const seedCounterparty = cleanCounterpartyName(tx.parser_counterparty_name || tx.counterparty_name);
      if (seedCounterparty && !isInvalidCounterparty(seedCounterparty)) {
        tx.counterparty_name = seedCounterparty;
        tx.counterparty_source = "parser_seed";
        tx.counterparty_confidence = roundConfidence(Math.max(tx.counterparty_confidence || 0, 0.65));
        tx.counterparty_needs_review = false;
      } else {
        tx.counterparty_name = "N.D.";
        tx.counterparty_source = "unknown";
        tx.counterparty_confidence = 0;
        tx.counterparty_needs_review = counterpartyCanUseLlm(tx.transaction_type);
      }
      continue;
    }

    if (isInvalidCounterparty(tx.counterparty_name)) {
      tx.counterparty_name = "N.D.";
      tx.counterparty_source = "unknown";
      tx.counterparty_confidence = 0;
      tx.counterparty_needs_review = counterpartyCanUseLlm(tx.transaction_type);
    }
  }

  const counterpartyReviewCount = transactions.filter((tx) => tx.counterparty_needs_review === true).length;

  return {
    llmDescriptionAttemptedCount,
    llmDescriptionResolvedCount,
    counterpartyAttemptedCount,
    counterpartyResolvedCount,
    counterpartyReviewCount,
    llmBatchFailCount,
    warnings,
  };
}

async function getTotalPages(pdfBase64: string): Promise<number> {
  const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  return pdfDoc.getPageCount();
}

async function callParser(
  parserUrl: string,
  parserToken: string,
  pdfBase64: string,
  startPage: number,
  endPage: number,
): Promise<ParserResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PARSER_TIMEOUT_MS);
  try {
    const response = await fetch(`${parserUrl}/extract-mps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": parserToken,
      },
      body: JSON.stringify({ pdfBase64, startPage, endPage }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Parser HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    const payload = raw ? JSON.parse(raw) as ParserResponse : {};
    return payload;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`Parser timeout dopo ${Math.round(PARSER_TIMEOUT_MS / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const pdfBase64 = body?.pdfBase64;
    const reqStartChunk = Number(body?.startChunk ?? 0);
    const reqMaxChunks = Number(body?.maxChunks ?? 1);

    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return new Response(JSON.stringify({ error: "Nessun PDF fornito" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parserUrl = (Deno.env.get("PDF_PARSER_URL") ?? "").replace(/\/$/, "");
    const parserToken = Deno.env.get("PDF_PARSER_TOKEN") ?? "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!parserUrl || !parserToken) {
      return new Response(JSON.stringify({ error: "PDF_PARSER_URL o PDF_PARSER_TOKEN non configurati" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalPages = await getTotalPages(pdfBase64);
    const totalChunks = Math.max(1, Math.ceil(totalPages / CHUNK_SIZE));
    const startChunk = Number.isFinite(reqStartChunk) ? Math.max(0, Math.floor(reqStartChunk)) : 0;
    const requestedMaxChunks = Number.isFinite(reqMaxChunks) ? Math.max(1, Math.floor(reqMaxChunks)) : 1;
    const maxChunks = Math.min(requestedMaxChunks, 3);
    const endChunkExclusive = Math.min(totalChunks, startChunk + maxChunks);

    if (startChunk >= totalChunks) {
      const emptyDone = new ReadableStream<Uint8Array>({
        start(controller) {
          sseData(controller, {
            type: "done",
            transactions: [],
            count: 0,
            stats: {
              raw_parsed_count: 0,
              dropped_missing_required_count: 0,
              dedup_edge_count: 0,
              dedup_client_count: 0,
              dedup_db_count: 0,
              saved_count: 0,
              failed_chunks_count: 0,
              warnings_count: 0,
              side_rule_count: 0,
              semantic_override_count: 0,
              unknown_side_count: 0,
              qc_fail_count: 0,
              summary_candidates_count: 0,
              llm_description_attempted_count: 0,
              llm_description_resolved_count: 0,
              counterparty_unknown_count: 0,
              counterparty_llm_attempted_count: 0,
              counterparty_llm_resolved_count: 0,
              counterparty_review_count: 0,
              llm_batch_fail_count: 0,
              raw_integrity_suspect_count: 0,
              raw_overlap_resolved_count: 0,
              raw_overlap_failed_count: 0,
            },
            summaryCandidates: [],
            statement: {
              openingBalance: null,
              closingBalance: null,
              closingDate: null,
            },
            totalChunks,
            startChunk,
            endChunk: startChunk,
            hasMore: false,
          });
          controller.close();
        },
      });

      return new Response(emptyDone, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let allTransactions: Tx[] = [];
        let allSummaryCandidates: Tx[] = [];
        const failedChunks: number[] = [];
        const warnings: string[] = [];

        let rawParsedCount = 0;
        let droppedMissingRequiredCount = 0;
        let parseErrorsCount = 0;
        let unknownSideCount = 0;
        let sideRuleCount = 0;
        let semanticOverrideCount = 0;
        let qcFailCount = 0;
        let summaryCandidatesCount = 0;
        let llmDescriptionAttemptedCount = 0;
        let llmDescriptionResolvedCount = 0;
        let counterpartyUnknownCount = 0;
        let counterpartyLlmAttemptedCount = 0;
        let counterpartyLlmResolvedCount = 0;
        let counterpartyReviewCount = 0;
        let llmBatchFailCount = 0;
        let rawIntegritySuspectCount = 0;
        let rawOverlapResolvedCount = 0;
        let rawOverlapFailedCount = 0;
        let statementOpeningBalance: number | null = null;
        let statementClosingBalance: number | null = null;
        let statementClosingDate: string | null = null;

        for (let i = startChunk; i < endChunkExclusive; i++) {
          const fromPage = i * CHUNK_SIZE + 1;
          const toPage = Math.min((i + 1) * CHUNK_SIZE, totalPages);
          const parserEndPage = i < totalChunks - 1 ? Math.min(toPage + 1, totalPages) : toPage;
          const overlapEnabled = parserEndPage > toPage;

          sseData(controller, {
            type: "progress",
            chunk: i + 1,
            total: totalChunks,
            found: allTransactions.length,
            message: overlapEnabled
              ? `🐍 Parsing pagine ${fromPage}-${toPage} (+ overlap ${parserEndPage}) con pdfplumber...`
              : `🐍 Parsing pagine ${fromPage}-${toPage} con pdfplumber...`,
          });

          let ok = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const parsed = await callParser(parserUrl, parserToken, pdfBase64, fromPage, parserEndPage);
              const parserTxAll = Array.isArray(parsed.transactions) ? parsed.transactions : [];
              const parserSummaryRowsAll = Array.isArray(parsed.summary_rows) ? parsed.summary_rows : [];

              const parserTx = parserTxAll.filter((row) => {
                const rowStart = toNumber(row?.start_page) ?? toNumber(row?.page);
                if (rowStart == null || !Number.isFinite(rowStart)) return true;
                return rowStart >= fromPage && rowStart <= toPage;
              });
              const parserSummaryRows = parserSummaryRowsAll.filter((row) => {
                const rowStart = toNumber(row?.start_page) ?? toNumber(row?.page);
                if (rowStart == null || !Number.isFinite(rowStart)) return true;
                return rowStart >= fromPage && rowStart <= toPage;
              });

              const mapped = parserTx.map(mapParserTx).filter(Boolean) as Tx[];
              const mappedSummary = parserSummaryRows.map(mapParserTx).filter(Boolean) as Tx[];
              const suspectMapped = mapped.filter((tx) => tx.raw_integrity === "suspect");

              if (suspectMapped.length > 0) {
                rawIntegritySuspectCount += suspectMapped.length;
                const overlapSuspects = suspectMapped.filter((tx) =>
                  overlapEnabled && tx.start_page != null && tx.start_page === toPage
                );
                rawOverlapFailedCount += overlapSuspects.length;
                const reasons = Array.from(new Set(
                  suspectMapped
                    .map((tx) => tx.raw_integrity_reason)
                    .filter((x): x is string => !!x),
                ));
                throw new Error(
                  `raw integrity suspect: ${suspectMapped.length} tx` +
                    (reasons.length ? ` (${reasons.join(", ")})` : ""),
                );
              }

              if (overlapEnabled) {
                const overlapResolved = mapped.filter((tx) =>
                  tx.start_page != null &&
                  tx.start_page === toPage &&
                  typeof tx.raw_text === "string" &&
                  tx.raw_text.includes("\n")
                ).length;
                rawOverlapResolvedCount += overlapResolved;
              }

              const rowsDetected = parserTx.length;
              const chunkUnknownSide = parserTx.filter((row) => normalizePostingSide(row?.posting_side) === "unknown").length;
              const chunkParseErrors = Number(parsed?.stats?.parse_errors || 0);
              const chunkSummaryRows = parserSummaryRows.length;
              const chunkQcFail = Number(parsed?.quality?.qc_fail_count || 0);
              const ledgerMatch = parsed?.quality?.ledger_match;
              const openingBalance = toNumber(parsed?.statement?.opening_balance);
              const closingBalance = toNumber(parsed?.statement?.closing_balance);
              const closingDate = clip(parsed?.statement?.closing_date, 20);

              rawParsedCount += rowsDetected;
              droppedMissingRequiredCount += Math.max(0, rowsDetected - mapped.length);
              parseErrorsCount += chunkParseErrors;
              unknownSideCount += chunkUnknownSide;
              qcFailCount += chunkQcFail;
              summaryCandidatesCount += Math.max(0, chunkSummaryRows);

              sideRuleCount += mapped.filter((t) => t.direction_source === "side_rule").length;
              semanticOverrideCount += mapped.filter((t) => t.direction_source === "semantic_rule").length;

              if (chunkParseErrors > 0) {
                warnings.push(`Chunk ${i + 1}: parse_errors=${chunkParseErrors}`);
              }
              if (chunkQcFail > 0) {
                warnings.push(`Chunk ${i + 1}: qc_fail_count=${chunkQcFail}`);
              }
              if (ledgerMatch === false) {
                warnings.push(`Chunk ${i + 1}: mismatch contabile (opening + in - out != closing)`);
              }

              allTransactions = allTransactions.concat(mapped);
              allSummaryCandidates = allSummaryCandidates.concat(mappedSummary);
              if (statementOpeningBalance == null && openingBalance != null) statementOpeningBalance = Math.abs(openingBalance);
              if (closingBalance != null) statementClosingBalance = Math.abs(closingBalance);
              if (closingDate) statementClosingDate = closingDate;

              console.log(
                `Chunk ${i + 1}: mapped=${mapped.length}, summary=${mappedSummary.length}, detected=${rowsDetected}, qc_fail=${chunkQcFail}`,
              );

              ok = true;
              break;
            } catch (err: any) {
              const msg = String(err?.message || err || "Errore sconosciuto");
              const retryable = msg.includes("429") || msg.includes("503") || msg.includes("timeout");
              if (attempt < 3 && retryable) {
                const waitSec = attempt * 10;
                sseData(controller, {
                  type: "waiting",
                  chunk: i + 1,
                  waitSec,
                  message: `⏳ Retry chunk ${i + 1} tra ${waitSec}s...`,
                });
                await delay(waitSec * 1000);
                continue;
              }
              console.error(`Chunk ${i + 1} failed:`, msg);
              failedChunks.push(i + 1);
              sseData(controller, {
                type: "chunk_error",
                chunk: i + 1,
                error: msg.substring(0, 200),
              });
              break;
            }
          }

          if (!ok) {
            warnings.push(`Chunk ${i + 1}: non completato`);
          }

          if (i < endChunkExclusive - 1) await delay(150);
        }

        if (allTransactions.length > 0) {
          if (!geminiApiKey) {
            warnings.push("LLM enrichment disattivato: GEMINI_API_KEY non configurata");
          } else {
            const llmResult = await enrichTransactionsWithLlm(geminiApiKey, allTransactions);
            llmDescriptionAttemptedCount += llmResult.llmDescriptionAttemptedCount;
            llmDescriptionResolvedCount += llmResult.llmDescriptionResolvedCount;
            counterpartyLlmAttemptedCount += llmResult.counterpartyAttemptedCount;
            counterpartyLlmResolvedCount += llmResult.counterpartyResolvedCount;
            counterpartyReviewCount = llmResult.counterpartyReviewCount;
            llmBatchFailCount += llmResult.llmBatchFailCount;
            warnings.push(...llmResult.warnings);
          }
        }

        counterpartyUnknownCount = allTransactions.filter((tx) => isInvalidCounterparty(tx.counterparty_name)).length;
        counterpartyReviewCount = allTransactions.filter((tx) => tx.counterparty_needs_review === true).length;

        const hasMore = endChunkExclusive < totalChunks;

        sseData(controller, {
          type: "done",
          transactions: allTransactions,
          count: allTransactions.length,
          stats: {
            raw_parsed_count: rawParsedCount,
            dropped_missing_required_count: droppedMissingRequiredCount,
            dedup_edge_count: 0,
            dedup_client_count: 0,
            dedup_db_count: 0,
            saved_count: 0,
            failed_chunks_count: failedChunks.length,
            warnings_count: warnings.length,
            side_rule_count: sideRuleCount,
            semantic_override_count: semanticOverrideCount,
            unknown_side_count: unknownSideCount,
            qc_fail_count: qcFailCount + parseErrorsCount,
            summary_candidates_count: allSummaryCandidates.length || summaryCandidatesCount,
            llm_description_attempted_count: llmDescriptionAttemptedCount,
            llm_description_resolved_count: llmDescriptionResolvedCount,
            counterparty_unknown_count: counterpartyUnknownCount,
            counterparty_llm_attempted_count: counterpartyLlmAttemptedCount,
            counterparty_llm_resolved_count: counterpartyLlmResolvedCount,
            counterparty_review_count: counterpartyReviewCount,
            llm_batch_fail_count: llmBatchFailCount,
            raw_integrity_suspect_count: rawIntegritySuspectCount,
            raw_overlap_resolved_count: rawOverlapResolvedCount,
            raw_overlap_failed_count: rawOverlapFailedCount,
          },
          summaryCandidates: allSummaryCandidates,
          statement: {
            openingBalance: statementOpeningBalance,
            closingBalance: statementClosingBalance,
            closingDate: statementClosingDate,
          },
          failedChunks: failedChunks.length ? failedChunks : undefined,
          warnings: warnings.length ? warnings : undefined,
          totalChunks,
          startChunk,
          endChunk: endChunkExclusive,
          hasMore,
          nextStartChunk: hasMore ? endChunkExclusive : undefined,
        });
        controller.close();
      },
      cancel(reason) {
        console.warn("SSE stream cancelled:", reason);
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    console.error("parse-bank-pdf-plumber error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Errore sconosciuto" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
