// supabase/functions/extract-coa-from-balance/index.ts
// Extracts chart of accounts from Italian balance sheet PDF using Gemini 2.5 Flash
import { PDFDocument } from "npm:pdf-lib@1.17.1";

// ─── CORS ──────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Types ─────────────────────────────────────────────────

interface ExtractedAccount {
  code: string;
  name: string;
  section: string;
  is_header: boolean;
  amount: number | null;
}

// ─── Gemini prompt ─────────────────────────────────────────

const EXTRACTION_PROMPT = `Sei un esperto contabile italiano. Analizza questo documento PDF che è un bilancio (o estratto del piano dei conti) di una società italiana.

Estrai TUTTI i conti contabili presenti. Per ogni conto, estrai:
- code: il codice numerico (es. "60830", "21107", "70005")
- name: il nome del conto (es. "Energia elettrica", "Automezzi specifici")
- section: la sezione, determinata dalla posizione nel bilancio:
  - Stato Patrimoniale Attivo → "assets"
  - Stato Patrimoniale Passivo - Patrimonio netto → "equity"
  - Stato Patrimoniale Passivo - Fondi, TFR, Debiti → "liabilities"
  - Conto Economico - Costi della produzione (B.6-B.8, 60xxx) → "cost_production"
  - Conto Economico - Personale (B.9, 61xxx) → "cost_personnel"
  - Conto Economico - Ammortamenti (B.10, 62xxx) → "depreciation"
  - Conto Economico - Altri costi (B.11-B.14, 63xxx) → "other_costs"
  - Conto Economico - Oneri finanziari (C.17, 64xxx) → "financial"
  - Conto Economico - Ricavi (A, 70xxx) → "revenue"
  - Conto Economico - Proventi finanziari (C.15-C.16, 72xxx) → "financial"
  - Conto Economico - Straordinari (E, 74xxx, 66xxx) → "extraordinary"
- is_header: true se è un conto intestazione (tipicamente codice a 2 cifre come "60", "70", "21", o titoli di sezione)
- amount: l'importo se presente (numero, null se non presente)

REGOLE:
- Estrai TUTTI i conti, anche quelli con importo zero
- I fondi ammortamento (21xxx nel passivo) sono "liabilities"
- I conti intestazione (es. "60 Costi della produzione") hanno is_header = true
- NON inventare conti che non sono nel PDF
- Mantieni i codici ESATTAMENTE come appaiono nel PDF
- Se un conto non ha codice numerico visibile, prova a inferirlo dal contesto o omettilo

Rispondi SOLO con JSON valido nel formato:
{"accounts": [{"code": "60830", "name": "Energia elettrica", "section": "cost_production", "is_header": false, "amount": 56197.22}, ...]}`;

// ─── PDF splitting ─────────────────────────────────────────

const MAX_PAGES_PER_CHUNK = 4;

async function splitPdf(
  pdfBase64: string,
  maxPagesPerChunk: number
): Promise<{ chunks: string[]; totalPages: number }> {
  const pdfBytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= maxPagesPerChunk) {
    return { chunks: [pdfBase64], totalPages };
  }

  const chunks: string[] = [];
  for (let i = 0; i < totalPages; i += maxPagesPerChunk) {
    const chunkDoc = await PDFDocument.create();
    const endPage = Math.min(i + maxPagesPerChunk, totalPages);
    const pages = await chunkDoc.copyPages(
      pdfDoc,
      Array.from({ length: endPage - i }, (_, k) => i + k)
    );
    for (const page of pages) chunkDoc.addPage(page);
    const chunkBytes = await chunkDoc.save();
    let binary = "";
    const bytes = new Uint8Array(chunkBytes);
    for (let j = 0; j < bytes.byteLength; j++) {
      binary += String.fromCharCode(bytes[j]);
    }
    chunks.push(btoa(binary));
  }

  return { chunks, totalPages };
}

// ─── Gemini extraction ─────────────────────────────────────

async function extractFromChunk(
  geminiKey: string,
  chunkBase64: string,
  chunkIndex: number,
  totalChunks: number
): Promise<ExtractedAccount[]> {
  const contextNote =
    totalChunks > 1
      ? `\n\nNOTA: Questo è il chunk ${chunkIndex + 1} di ${totalChunks} del documento. Estrai solo i conti visibili in queste pagine.`
      : "";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: chunkBase64,
              },
            },
            { text: EXTRACTION_PROMPT + contextNote },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 16384,
        responseMimeType: "application/json",
      },
      // thinkingConfig MUST be top-level, NOT nested inside generationConfig
      thinkingConfig: { thinkingBudget: 0 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(
      `Gemini chunk ${chunkIndex + 1}/${totalChunks} error: ${res.status}`,
      errText
    );
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const payload = await res.json();
  const rawText =
    payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  if (!rawText) {
    console.warn(`Chunk ${chunkIndex + 1}: empty Gemini response`);
    return [];
  }

  // Parse JSON response (strip markdown fences if present)
  const cleaned = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  let parsed: { accounts?: ExtractedAccount[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in response
    const objStart = cleaned.indexOf("{");
    const objEnd = cleaned.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) {
      try {
        parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      } catch {
        // Try array format
        const arrStart = cleaned.indexOf("[");
        const arrEnd = cleaned.lastIndexOf("]");
        if (arrStart >= 0 && arrEnd > arrStart) {
          try {
            const arr = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
            parsed = { accounts: arr };
          } catch {
            console.error(
              `Chunk ${chunkIndex + 1}: JSON parse failed`,
              cleaned.slice(0, 200)
            );
            return [];
          }
        } else {
          console.error(
            `Chunk ${chunkIndex + 1}: no valid JSON found`,
            cleaned.slice(0, 200)
          );
          return [];
        }
      }
    } else {
      return [];
    }
  }

  const accounts = parsed?.accounts || [];

  // Validate and sanitize each account
  const validSections = new Set([
    "assets",
    "liabilities",
    "equity",
    "revenue",
    "cost_production",
    "cost_personnel",
    "depreciation",
    "other_costs",
    "financial",
    "extraordinary",
  ]);

  return accounts
    .filter(
      (a) =>
        a &&
        typeof a.code === "string" &&
        a.code.trim() &&
        typeof a.name === "string" &&
        a.name.trim()
    )
    .map((a) => ({
      code: a.code.trim(),
      name: a.name.trim(),
      section: validSections.has(a.section) ? a.section : "other_costs",
      is_header: a.is_header === true,
      amount: typeof a.amount === "number" ? a.amount : null,
    }));
}

// ─── Main handler ──────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
    if (!geminiKey) {
      return json({ error: "GEMINI_API_KEY non configurata" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const pdfBase64: string | undefined = body.pdf_base64;

    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return json({ error: "pdf_base64 è obbligatorio" }, 400);
    }

    // Split PDF into chunks if needed
    console.log("[extract-coa] Splitting PDF...");
    const { chunks, totalPages } = await splitPdf(
      pdfBase64,
      MAX_PAGES_PER_CHUNK
    );
    console.log(
      `[extract-coa] ${totalPages} pages, ${chunks.length} chunks`
    );

    // Extract from each chunk
    const allAccounts: ExtractedAccount[] = [];
    const seenCodes = new Set<string>();

    for (let i = 0; i < chunks.length; i++) {
      console.log(
        `[extract-coa] Processing chunk ${i + 1}/${chunks.length}...`
      );
      try {
        const chunkAccounts = await extractFromChunk(
          geminiKey,
          chunks[i],
          i,
          chunks.length
        );

        // Deduplicate: keep first occurrence of each code
        for (const acc of chunkAccounts) {
          if (!seenCodes.has(acc.code)) {
            seenCodes.add(acc.code);
            allAccounts.push(acc);
          }
        }

        console.log(
          `[extract-coa] Chunk ${i + 1}: ${chunkAccounts.length} accounts (${allAccounts.length} total unique)`
        );
      } catch (err) {
        console.error(`[extract-coa] Chunk ${i + 1} failed:`, err);
        // Continue with other chunks
      }
    }

    // Sort by code for consistent output
    allAccounts.sort((a, b) => a.code.localeCompare(b.code));

    console.log(
      `[extract-coa] Done: ${allAccounts.length} unique accounts from ${totalPages} pages`
    );

    return json({
      accounts: allAccounts,
      total_pages: totalPages,
      chunks_processed: chunks.length,
    });
  } catch (e) {
    console.error("[extract-coa] Error:", e);
    return json(
      { error: e instanceof Error ? e.message : "Errore sconosciuto" },
      500
    );
  }
});
