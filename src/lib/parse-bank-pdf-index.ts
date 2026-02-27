// supabase/functions/parse-bank-pdf/index.ts
// Adattato dall'approccio Lovable: PDF come documento a Claude, 10 pagine per chunk, SSE streaming
import Anthropic from "npm:@anthropic-ai/sdk";
import { PDFDocument } from "npm:pdf-lib";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function splitPdfIntoChunks(pdfBase64: string, chunkSize = 10): Promise<string[]> {
  const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= chunkSize) return [pdfBase64];

  const chunks: string[] = [];
  for (let i = 0; i < totalPages; i += chunkSize) {
    const chunkDoc = await PDFDocument.create();
    const endPage = Math.min(i + chunkSize, totalPages);
    const pages = await chunkDoc.copyPages(
      pdfDoc,
      Array.from({ length: endPage - i }, (_, k) => i + k)
    );
    pages.forEach((page) => chunkDoc.addPage(page));
    const chunkBytes = await chunkDoc.save();
    let binary = "";
    const bytes = new Uint8Array(chunkBytes);
    for (let j = 0; j < bytes.byteLength; j++) binary += String.fromCharCode(bytes[j]);
    chunks.push(btoa(binary));
  }

  console.log(`PDF split into ${chunks.length} chunks (${totalPages} pages, ${chunkSize}/chunk)`);
  return chunks;
}

const PROMPT = `Sei un esperto contabile italiano. Estrai TUTTI i movimenti bancari da questo estratto conto (MPS Monte dei Paschi di Siena o simile).

Per OGNI movimento estrai:
- date: data operazione "DD/MM/YYYY"
- value_date: data valuta "DD/MM/YYYY"
- amount: importo numerico (negativo=uscite/addebiti, positivo=entrate/accrediti)
- commission: commissioni se presenti come numero positivo (es. 1.50), altrimenti null
- description: causale/descrizione completa
- counterparty_name: nome controparte (beneficiario o ordinante)
- counterparty_account: IBAN o conto della controparte, se presente
- transaction_type: uno tra "bonifico_in","bonifico_out","riba","sdd","pos","prelievo","commissione","stipendio","f24","altro"
- reference: numero riferimento, CRO, TRN
- invoice_ref: numero fattura se presente nel testo (es. 195/FE/25, FAT.123), altrimenti null
- cbi_flow_id: ID flusso CBI se presente, altrimenti null
- branch: filiale disponente se presente, altrimenti null
- raw_text: TESTO COMPLETO integrale del movimento, tutte le righe senza troncare

IMPORTANTE:
- Negativi=uscite/addebiti. Positivi=entrate/accrediti.
- commission: valore POSITIVO se presente (es. 1.50, non -1.50)
- Includi TUTTI i movimenti, non saltare nessuna pagina
- raw_text deve contenere TUTTO il testo originale del movimento

Restituisci SOLO un array JSON valido, nessun testo aggiuntivo:
[{"date":"DD/MM/YYYY","value_date":"DD/MM/YYYY","amount":-123.45,"commission":1.50,"description":"testo","counterparty_name":"nome","counterparty_account":"IT...","transaction_type":"bonifico_out","reference":"ref","invoice_ref":null,"cbi_flow_id":null,"branch":null,"raw_text":"testo completo"}]`;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repairJson(raw: string): any[] {
  const s = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch {}
  // Prova a chiudere array troncato
  const lastComplete = s.lastIndexOf("},");
  if (lastComplete > 0) {
    try { const p = JSON.parse(s.substring(0, lastComplete + 1) + "]"); return Array.isArray(p) ? p : []; } catch {}
  }
  const lastObj = s.lastIndexOf("}");
  if (lastObj > 0) {
    try { const p = JSON.parse(s.substring(0, lastObj + 1) + "]"); return Array.isArray(p) ? p : []; } catch {}
  }
  console.error("JSON repair failed, length:", s.length);
  return [];
}

async function processChunk(client: Anthropic, chunkBase64: string): Promise<any[]> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: chunkBase64 },
          },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  const rawText = response.content[0].type === "text" ? response.content[0].text : "";
  const stopReason = response.stop_reason;
  console.log(`Chunk: ${rawText.length} chars, stop_reason: ${stopReason}`);

  const results = repairJson(rawText);
  if (stopReason !== "end_turn") {
    console.warn(`Truncated (${stopReason}), recovered ${results.length} transactions`);
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { pdfBase64 } = await req.json();
    if (!pdfBase64) {
      return new Response(
        JSON.stringify({ error: "Nessun PDF fornito" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata. Vai su Supabase > Edge Functions > Secrets." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const client = new Anthropic({ apiKey });
    const chunks = await splitPdfIntoChunks(pdfBase64, 10);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: any) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        let allTransactions: any[] = [];
        const failedChunks: number[] = [];

        for (let i = 0; i < chunks.length; i++) {
          send({ type: "progress", chunk: i + 1, total: chunks.length, found: allTransactions.length });
          console.log(`Processing chunk ${i + 1}/${chunks.length}...`);

          let attempts = 0;
          while (attempts < 3) {
            try {
              const txns = await processChunk(client, chunks[i]);
              allTransactions = allTransactions.concat(txns);
              console.log(`Chunk ${i + 1}: ${txns.length} transactions`);
              break;
            } catch (err: any) {
              attempts++;
              if (err?.status === 429 && attempts < 3) {
                const waitSec = 30;
                console.log(`Rate limited chunk ${i + 1}, waiting ${waitSec}s (attempt ${attempts}/3)...`);
                send({ type: "waiting", chunk: i + 1, waitSec });
                await delay(waitSec * 1000);
              } else {
                console.error(`Chunk ${i + 1} failed (attempt ${attempts}):`, err?.message);
                failedChunks.push(i + 1);
                break;
              }
            }
          }

          // Pausa tra chunks per evitare rate limit
          if (i < chunks.length - 1) await delay(3000);
        }

        console.log(`Total: ${allTransactions.length} transactions, ${failedChunks.length} failed chunks`);
        send({
          type: "done",
          transactions: allTransactions,
          count: allTransactions.length,
          failedChunks: failedChunks.length > 0 ? failedChunks : undefined,
        });
        controller.close();
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
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
