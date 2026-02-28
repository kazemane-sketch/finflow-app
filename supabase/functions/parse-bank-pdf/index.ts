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
const CHUNK_SIZE = Number(Deno.env.get("PDF_CHUNK_PAGES") ?? "2");
const MAX_OUTPUT_TOKENS = Number(Deno.env.get("GEMINI_MAX_OUTPUT_TOKENS") ?? "32768");

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
};

type GeminiChunkResult = {
  txns: Tx[];
  finishReason: string;
  rawLength: number;
};

const PROMPT = `Sei un parser contabile italiano.
Estrai i movimenti bancari presenti nel PDF (estratto conto MPS o simile).
Restituisci SOLO JSON valido, senza testo extra.

Formato richiesto:
{
  "transactions": [
    {
      "date": "DD/MM/YYYY",
      "value_date": "DD/MM/YYYY oppure null",
      "amount": numero (negativo=uscita, positivo=entrata),
      "commission": numero positivo oppure null,
      "description": "causale completa",
      "counterparty_name": "nome controparte oppure null",
      "transaction_type": "bonifico_in|bonifico_out|riba|sdd|pos|prelievo|commissione|stipendio|f24|altro",
      "reference": "CRO/TRN/rif oppure null",
      "invoice_ref": "numero fattura se presente, altrimenti null",
      "category_code": "codice causale se presente, altrimenti null",
      "raw_text": "estratto testo max 180 caratteri, oppure null"
    }
  ]
}

Regole:
- Includi TUTTI i movimenti presenti nel chunk.
- Non inventare dati mancanti.
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

function sanitizeTx(x: any): Tx | null {
  const date = clip(x?.date, 20);
  const amount = toNumber(x?.amount);
  if (!date || amount == null) return null;
  const commissionRaw = toNumber(x?.commission);
  const commission = commissionRaw == null ? null : Math.abs(commissionRaw);

  return {
    date,
    value_date: clip(x?.value_date, 20),
    amount,
    commission,
    description: clip(x?.description, 400) ?? "",
    counterparty_name: clip(x?.counterparty_name, 180),
    transaction_type: normType(x?.transaction_type),
    reference: clip(x?.reference, 120),
    invoice_ref: clip(x?.invoice_ref, 80),
    category_code: clip(x?.category_code, 40),
    raw_text: clip(x?.raw_text, 180),
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

function dedupeTx(items: Tx[]): Tx[] {
  const seen = new Set<string>();
  const out: Tx[] = [];
  for (const t of items) {
    const key = `${t.date}|${t.amount}|${(t.description ?? "").slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
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
  if (!rawText) return { txns: [], finishReason, rawLength: 0 };

  const parsed = tryParseAnyJson(rawText);
  const sanitized = parsed.map(sanitizeTx).filter(Boolean) as Tx[];
  const txns = dedupeTx(sanitized);
  return { txns, finishReason, rawLength: rawText.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const pdfBase64 = body?.pdfBase64;
    const reqStartChunk = Number(body?.startChunk ?? 0);
    const reqMaxChunks = Number(body?.maxChunks ?? 3);
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
    const maxChunks = Number.isFinite(reqMaxChunks) ? Math.min(8, Math.max(1, Math.floor(reqMaxChunks))) : 3;
    const endChunkExclusive = Math.min(totalChunks, startChunk + maxChunks);

    if (startChunk >= totalChunks) {
      const emptyDone = new ReadableStream<Uint8Array>({
        start(controller) {
          sseData(controller, {
            type: "done",
            transactions: [],
            count: 0,
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

        allTransactions = dedupeTx(allTransactions);
        const hasMore = endChunkExclusive < totalChunks;

        console.log(`Total: ${allTransactions.length} transactions, ${failedChunks.length} failed chunks`);
        sseData(controller, {
          type: "done",
          transactions: allTransactions,
          count: allTransactions.length,
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
