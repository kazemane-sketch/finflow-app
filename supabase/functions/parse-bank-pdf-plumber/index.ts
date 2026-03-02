import { PDFDocument } from "npm:pdf-lib";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHUNK_SIZE = Number(Deno.env.get("PDF_PLUMBER_CHUNK_PAGES") ?? Deno.env.get("PDF_CHUNK_PAGES") ?? "6");
const PARSER_TIMEOUT_MS = Number(Deno.env.get("PDF_PARSER_TIMEOUT_MS") ?? "120000");

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
  summary_reason?: string | null;
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
  column_confidence?: unknown;
  qc_needs_review?: unknown;
  row_reason?: unknown;
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

  const description = clip(item?.description, 600) ?? "";
  const rawText = clip(item?.raw_text, 5000) ?? description;
  const reference = clip(item?.reference, 120);
  const categoryCode = clip(item?.category_code, 40);

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
    decision = inferDirectionSemantic(normalizeText(`${description} ${rawText} ${reference ?? ""}`), "altro");
    decision.needsReview = true;
  }

  let txType = normType(item?.transaction_type);
  if (txType === "altro") {
    txType = inferTypeByText(`${description} ${rawText}`, decision.direction);
  }

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
    description,
    counterparty_name: clip(item?.counterparty_name, 220),
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
    summary_reason: clip(item?.row_reason, 120),
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
        let statementOpeningBalance: number | null = null;
        let statementClosingBalance: number | null = null;
        let statementClosingDate: string | null = null;

        for (let i = startChunk; i < endChunkExclusive; i++) {
          const fromPage = i * CHUNK_SIZE + 1;
          const toPage = Math.min((i + 1) * CHUNK_SIZE, totalPages);

          sseData(controller, {
            type: "progress",
            chunk: i + 1,
            total: totalChunks,
            found: allTransactions.length,
            message: `🐍 Parsing pagine ${fromPage}-${toPage} con pdfplumber...`,
          });

          let ok = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const parsed = await callParser(parserUrl, parserToken, pdfBase64, fromPage, toPage);
              const parserTx = Array.isArray(parsed.transactions) ? parsed.transactions : [];
              const parserSummaryRows = Array.isArray(parsed.summary_rows) ? parsed.summary_rows : [];
              const mapped = parserTx.map(mapParserTx).filter(Boolean) as Tx[];
              const mappedSummary = parserSummaryRows.map(mapParserTx).filter(Boolean) as Tx[];

              const rowsDetected = Number(parsed?.stats?.rows_detected || parserTx.length || 0);
              const chunkUnknownSide = Number(parsed?.stats?.rows_unknown_side || 0);
              const chunkParseErrors = Number(parsed?.stats?.parse_errors || 0);
              const chunkSummaryRows = Number(parsed?.stats?.summary_rows_detected || parserSummaryRows.length || 0);
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
