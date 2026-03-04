// supabase/functions/parse-bank-pdf/index.ts
// Estrazione movimenti bancari da PDF con Gemini + SSE progress.
// Robustezza: chunk piccoli, retry/backoff, parse JSON tollerante.
import { PDFDocument } from "npm:pdf-lib";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
const CHUNK_SIZE = Number(Deno.env.get("PDF_CHUNK_PAGES") ?? "1");
const MAX_OUTPUT_TOKENS = Number(Deno.env.get("GEMINI_MAX_OUTPUT_TOKENS") ?? "32768");

type PostingSide = "dare" | "avere" | "unknown";
type Direction = "in" | "out";
type DirectionSource = "side_rule" | "semantic_rule" | "amount_fallback" | "manual";
type AmountSignExplicit = "minus" | "plus_or_none" | "unknown";

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
};

type GeminiChunkResult = {
  txns: Tx[];
  finishReason: string;
  rawLength: number;
  rawParsedCount: number;
  droppedMissingRequiredCount: number;
};

type SemanticKeyword = { needle: string; weight: number };

type DirectionInference = {
  direction: Direction;
  source: DirectionSource;
  confidence: number;
  needsReview: boolean;
  reason: string;
};

type SideSource = "explicit" | "inferred" | "unknown";

const OUT_KEYWORDS: SemanticKeyword[] = [
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

const IN_KEYWORDS: SemanticKeyword[] = [
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

const PROMPT = `Sei un parser contabile italiano.
Estrai i movimenti bancari presenti nel PDF (estratto conto MPS o simile).
Restituisci SOLO JSON valido, senza testo extra.

Formato richiesto:
{
  "transactions": [
    {
      "date": "DD/MM/YYYY",
      "value_date": "DD/MM/YYYY oppure null",
      "amount": numero assoluto o con segno,
      "amount_text": "importo come appare nel PDF (es. 3.671,98 oppure -3.671,98 oppure (3.671,98))",
      "commission": numero positivo oppure null,
      "description": "causale completa",
      "counterparty_name": "nome controparte oppure null",
      "transaction_type": "bonifico_in|bonifico_out|riba|sdd|pos|prelievo|commissione|stipendio|f24|altro",
      "reference": "CRO/TRN/rif oppure null",
      "invoice_ref": "numero fattura se presente, altrimenti null",
      "category_code": "codice causale se presente, altrimenti null",
      "raw_text": "testo integrale movimento (non troncare)",
      "posting_side": "dare|avere|unknown",
      "direction": "in|out"
    }
  ]
}

Regole importanti:
- Includi TUTTI i movimenti presenti nel chunk.
- NON includere righe "SALDO INIZIALE", "SALDO FINALE", "SALDO CONTABILE", "SALDO DISPONIBILE" come transazioni. Sono righe di riepilogo, non movimenti bancari reali.
- Determina posting_side dalla colonna del movimento: DARE o AVERE, se visibile.
- Matrice contabile con segno esplicito su amount_text:
  - DARE + (o senza segno) => out
  - DARE - (oppure in parentesi) => in
  - AVERE + (o senza segno) => in
  - AVERE - (oppure in parentesi) => out
- Se posting_side non è determinabile metti "unknown".
- Se non trovi movimenti, restituisci {"transactions":[]}.`;

function sseData(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown) {
  const enc = new TextEncoder();
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeText(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[^a-z0-9àèéìòù\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundConfidence(v: number): number {
  const bounded = Math.min(1, Math.max(0, v));
  return Math.round(bounded * 100) / 100;
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

function inferPostingSideFromText(text: string): PostingSide {
  const hasDare = /\bmov\.?\s*dare\b|\bmovimento\s*dare\b|\bdare\b/.test(text);
  const hasAvere = /\bmov\.?\s*avere\b|\bmovimento\s*avere\b|\bavere\b/.test(text);

  if (hasDare && !hasAvere) return "dare";
  if (hasAvere && !hasDare) return "avere";
  return "unknown";
}

function normalizeDirection(v: unknown): Direction | null {
  const s = normalizeText(v);
  if (!s) return null;
  if (s === "in" || s.includes("entrata") || s.includes("accredito")) return "in";
  if (s === "out" || s.includes("uscita") || s.includes("addebito")) return "out";
  return null;
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

function scoreKeywords(text: string, rules: SemanticKeyword[]): { score: number; hits: string[] } {
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

function inferDirectionFromSemantic(text: string, llmDirection: Direction | null): DirectionInference | null {
  if (!text) return null;

  const inScore = scoreKeywords(text, IN_KEYWORDS);
  const outScore = scoreKeywords(text, OUT_KEYWORDS);

  let totalIn = inScore.score;
  let totalOut = outScore.score;

  if (llmDirection === "in") totalIn += 0.8;
  if (llmDirection === "out") totalOut += 0.8;

  if (totalIn === 0 && totalOut === 0) return null;

  if (totalIn === totalOut) {
    if (!llmDirection) return null;
    return {
      direction: llmDirection,
      source: "semantic_rule",
      confidence: 0.68,
      needsReview: true,
      reason: `Segnali semantici in parita, uso direzione LLM (${llmDirection})`,
    };
  }

  const direction: Direction = totalOut > totalIn ? "out" : "in";
  const diff = Math.abs(totalOut - totalIn);

  let confidence = diff >= 2 ? 0.9 : diff >= 1 ? 0.8 : 0.72;
  if (llmDirection && llmDirection === direction) confidence += 0.06;
  if (llmDirection && llmDirection !== direction) confidence -= 0.08;

  const hits = direction === "out" ? outScore.hits : inScore.hits;
  const hitLabel = hits.length > 0 ? hits.slice(0, 3).join(", ") : "llm";

  return {
    direction,
    source: "semantic_rule",
    confidence: roundConfidence(confidence),
    needsReview: roundConfidence(confidence) < 0.7,
    reason: `Regola semantica: ${hitLabel}`,
  };
}

function withTypeConflictGuard(decision: DirectionInference, txType: string): DirectionInference {
  const expected = expectedDirectionFromType(txType);
  if (!expected || expected === decision.direction) return decision;
  return {
    ...decision,
    confidence: roundConfidence(Math.min(decision.confidence, 0.69)),
    needsReview: true,
    reason: `${decision.reason}; conflitto con transaction_type=${txType} (review)`,
  };
}

function resolveDirection(
  postingSide: PostingSide,
  sideSource: SideSource,
  amountSignExplicit: AmountSignExplicit,
  llmDirection: Direction | null,
  semanticText: string,
  txType: string,
): DirectionInference {
  if (postingSide !== "unknown") {
    const explicitMinus = amountSignExplicit === "minus";
    const direction: Direction = postingSide === "dare"
      ? (explicitMinus ? "in" : "out")
      : (explicitMinus ? "out" : "in");
    const signKnown = amountSignExplicit !== "unknown";
    const highConfidence = sideSource === "explicit" && signKnown;
    const baseReason = explicitMinus
      ? `Regola ${postingSide.toUpperCase()} + segno esplicito '-' => ${direction === "in" ? "entrata" : "uscita"}`
      : `Regola ${postingSide.toUpperCase()} + importo senza segno esplicito => ${direction === "in" ? "entrata" : "uscita"}`;
    const reason = sideSource === "inferred"
      ? `${baseReason} (colonna ${postingSide.toUpperCase()} inferita da testo)`
      : sideSource === "unknown"
      ? `${baseReason} (colonna non esplicita)`
      : baseReason;

    return withTypeConflictGuard({
      direction,
      source: "side_rule",
      confidence: highConfidence ? 0.95 : 0.78,
      needsReview: !highConfidence || sideSource !== "explicit",
      reason,
    }, txType);
  }

  const semantic = inferDirectionFromSemantic(semanticText, llmDirection);
  if (semantic) {
    return withTypeConflictGuard({
      ...semantic,
      confidence: roundConfidence(semantic.confidence),
      needsReview: semantic.confidence < 0.7,
    }, txType);
  }

  if (llmDirection) {
    return withTypeConflictGuard({
      direction: llmDirection,
      source: "semantic_rule",
      confidence: 0.66,
      needsReview: true,
      reason: "Direzione LLM usata senza indicatori DARE/AVERE",
    }, txType);
  }

  return withTypeConflictGuard({
    direction: "in",
    source: "amount_fallback",
    confidence: 0.5,
    needsReview: true,
    reason: "Fallback conservativo: posting_side sconosciuto, importo assunto positivo",
  }, txType);
}

function sanitizeTx(x: any): Tx | null {
  const date = clip(x?.date, 20);
  const amountText = clip(x?.amount_text, 80);
  const amountNumericSource = amountText ?? x?.amount;
  const amountNum = toNumber(amountNumericSource);
  if (!date || amountNum == null) return null;

  const description = clip(x?.description, 600) ?? "";
  const rawText = clip(x?.raw_text, 4000) ?? null;
  const reference = clip(x?.reference, 120);
  const categoryCode = clip(x?.category_code, 40);
  const txType = normType(x?.transaction_type);

  const semanticText = normalizeText([description, rawText ?? "", reference ?? "", categoryCode ?? ""].join(" "));
  const rawPostingSide = normalizePostingSide(x?.posting_side);
  let postingSide = rawPostingSide;
  let sideSource: SideSource = rawPostingSide !== "unknown" ? "explicit" : "unknown";
  if (postingSide === "unknown") {
    const inferred = inferPostingSideFromText(semanticText);
    if (inferred !== "unknown") {
      postingSide = inferred;
      sideSource = "inferred";
    }
  }

  const amountTextRaw = amountText ?? (typeof x?.amount === "string" ? String(x.amount).trim() : null);
  const amountSignExplicit = detectExplicitAmountSign(amountTextRaw);
  const llmDirection = normalizeDirection(x?.direction);
  const directionDecision = resolveDirection(
    postingSide,
    sideSource,
    amountSignExplicit,
    llmDirection,
    semanticText,
    txType,
  );

  const amountAbs = Math.abs(amountNum);
  const normalizedAmount = directionDecision.direction === "in" ? amountAbs : -amountAbs;

  const commissionRaw = toNumber(x?.commission);
  const commission = commissionRaw == null ? null : Math.abs(commissionRaw);

  return {
    date,
    value_date: clip(x?.value_date, 20),
    amount: normalizedAmount,
    commission,
    description,
    counterparty_name: clip(x?.counterparty_name, 180),
    transaction_type: txType,
    reference,
    invoice_ref: clip(x?.invoice_ref, 80),
    category_code: categoryCode,
    raw_text: rawText,
    amount_text: amountText ?? (typeof x?.amount === "string" ? clip(x?.amount, 80) : null),
    amount_sign_explicit: amountSignExplicit,
    posting_side: postingSide,
    direction: directionDecision.direction,
    direction_source: directionDecision.source,
    direction_confidence: roundConfidence(directionDecision.confidence),
    direction_needs_review: directionDecision.needsReview,
    direction_reason: clip(directionDecision.reason, 240) || "Direzione determinata automaticamente",
  };
}

function normalizePayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.transactions)) return payload.transactions;
  if (payload && Array.isArray(payload.movimenti)) return payload.movimenti;
  if (payload?.data && Array.isArray(payload.data.transactions)) return payload.data.transactions;
  if (payload?.result && Array.isArray(payload.result.transactions)) return payload.result.transactions;
  return [];
}

function tryParseAnyJson(text: string): any[] {
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

async function splitPdfIntoChunks(pdfBase64: string, chunkSize = CHUNK_SIZE): Promise<{ chunks: string[]; totalPages: number }> {
  const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= chunkSize) return { chunks: [pdfBase64], totalPages };

  const chunks: string[] = [];
  for (let i = 0; i < totalPages; i += chunkSize) {
    const chunkDoc = await PDFDocument.create();
    const endPage = Math.min(i + chunkSize, totalPages);
    const pages = await chunkDoc.copyPages(pdfDoc, Array.from({ length: endPage - i }, (_, k) => i + k));
    for (const page of pages) chunkDoc.addPage(page);
    const chunkBytes = await chunkDoc.save();
    let binary = "";
    const bytes = new Uint8Array(chunkBytes);
    for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
    chunks.push(btoa(binary));
  }

  console.log(`PDF split into ${chunks.length} chunks (${totalPages} pages, ${chunkSize}/chunk)`);
  return { chunks, totalPages };
}

async function processChunkWithGemini(apiKey: string, chunkBase64: string): Promise<GeminiChunkResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "application/pdf", data: chunkBase64 } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error(`Gemini API error ${response.status}:`, errBody.slice(0, 500));
    throw new Error(`Gemini API error ${response.status}`);
  }

  const data = await response.json();
  const finishReason = data?.candidates?.[0]?.finishReason || "UNKNOWN";
  const rawText = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n")
    .trim();

  console.log(`Gemini chunk: ${rawText.length} chars, finishReason: ${finishReason}`);
  if (!rawText) {
    return {
      txns: [],
      finishReason,
      rawLength: 0,
      rawParsedCount: 0,
      droppedMissingRequiredCount: 0,
    };
  }

  const parsed = tryParseAnyJson(rawText);
  const sanitized = parsed.map(sanitizeTx).filter(Boolean) as Tx[];
  return {
    txns: sanitized,
    finishReason,
    rawLength: rawText.length,
    rawParsedCount: parsed.length,
    droppedMissingRequiredCount: Math.max(0, parsed.length - sanitized.length),
  };
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

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "GEMINI_API_KEY non configurata. Vai su Supabase > Edge Functions > Secrets e aggiungi la chiave.",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { chunks, totalPages } = await splitPdfIntoChunks(pdfBase64, CHUNK_SIZE);
    const totalChunks = chunks.length;
    const startChunk = Number.isFinite(reqStartChunk) ? Math.max(0, Math.floor(reqStartChunk)) : 0;
    const requestedMaxChunks = Number.isFinite(reqMaxChunks) ? Math.max(1, Math.floor(reqMaxChunks)) : 1;
    const hardCapByDocSize = totalChunks > 15 ? 1 : 2;
    const maxChunks = Math.min(requestedMaxChunks, hardCapByDocSize);
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
        const failedChunks: number[] = [];
        const warnings: string[] = [];
        let allTransactions: Tx[] = [];
        let rawParsedCount = 0;
        let droppedMissingRequiredCount = 0;

        for (let i = startChunk; i < endChunkExclusive; i++) {
          const fromPage = i * CHUNK_SIZE + 1;
          const toPage = Math.min((i + 1) * CHUNK_SIZE, totalPages);

          sseData(controller, {
            type: "progress",
            chunk: i + 1,
            total: totalChunks,
            found: allTransactions.length,
            message: `🤖 Analisi pagine ${fromPage}-${toPage}...`,
          });
          console.log(`Processing chunk ${i + 1}/${totalChunks} (pages ${fromPage}-${toPage})...`);

          let ok = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const out = await processChunkWithGemini(apiKey, chunks[i]);
              if (out.finishReason === "MAX_TOKENS") {
                warnings.push(`Chunk ${i + 1}: output troncato (MAX_TOKENS).`);
              }
              rawParsedCount += out.rawParsedCount;
              droppedMissingRequiredCount += out.droppedMissingRequiredCount;
              allTransactions = allTransactions.concat(out.txns);
              console.log(
                `Chunk ${i + 1}: ${out.txns.length} transactions (finishReason=${out.finishReason}, chars=${out.rawLength})`,
              );

              if (out.txns.length === 0) {
                warnings.push(`Chunk ${i + 1}: nessun movimento estratto.`);
              }
              ok = true;
              break;
            } catch (err: any) {
              const msg = String(err?.message || err || "Errore sconosciuto");
              const isRateLimit = msg.includes("429");
              const isRetryable = isRateLimit || msg.includes("503") || msg.includes("deadline");
              if (attempt < 3 && isRetryable) {
                const waitSec = attempt * 15;
                console.warn(`Chunk ${i + 1} attempt ${attempt}/3 failed (${msg}). Waiting ${waitSec}s...`);
                sseData(controller, {
                  type: "waiting",
                  chunk: i + 1,
                  waitSec,
                  message: `⏳ Retry chunk ${i + 1} tra ${waitSec}s...`,
                });
                await delay(waitSec * 1000);
                continue;
              }
              console.error(`Chunk ${i + 1} failed (attempt ${attempt}/3):`, msg);
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
            // no-op: chunk segnato come failed
          }

          if (i < endChunkExclusive - 1) await delay(250);
        }

        const hasMore = endChunkExclusive < totalChunks;

        console.log(`Total: ${allTransactions.length} transactions, ${failedChunks.length} failed chunks`);
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
    console.error("parse-bank-pdf error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Errore sconosciuto" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
