// kb-process-document/index.ts
// Two actions:
//   process  — text extraction (PDF/URL/text) + chunking + embedding
//   classify — AI metadata via Gemini (model from agent_config kb_classifier; fills taxonomy, applicability, relations)

import { createClient } from "npm:@supabase/supabase-js@2";

/* ─── CORS ──────────────────────────────────────── */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─── Models ──────────────────────────────────────── */
const EMBEDDING_MODEL = "gemini-embedding-001";
const FLASH_MODEL = "gemini-2.5-flash";
const DEFAULT_PRO_MODEL = "gemini-2.5-pro";
const DEFAULT_THINKING_BUDGET = 8192;
const EMBEDDING_DIMS = 3072;

// Models that crash if thinkingConfig is sent at all
const NO_THINKING_CONFIG_MODELS = ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools"];
const CHUNK_TARGET_CHARS = 3200; // ~800 tokens
const CHUNK_OVERLAP_CHARS = 400; // ~100 tokens
const MAX_CHUNKS = 200;

/* ─── Helpers ───────────────────────────────────── */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}]`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip null bytes, escaped null bytes, and control chars (except \t \n \r) */
function sanitizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\\u0000/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim();
}

/** Decode HTML entities that Gemini PDF extraction sometimes leaves in text */
function sanitizeHtmlEntities(text: string): string {
  return text
    // Named entities — common ones
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ordm;/g, "º")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&euro;/g, "€")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&bull;/g, "•")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    // Italian accented vowels
    .replace(/&agrave;/g, "à")
    .replace(/&egrave;/g, "è")
    .replace(/&eacute;/g, "é")
    .replace(/&igrave;/g, "ì")
    .replace(/&ograve;/g, "ò")
    .replace(/&ugrave;/g, "ù")
    .replace(/&Agrave;/g, "À")
    .replace(/&Egrave;/g, "È")
    .replace(/&Eacute;/g, "É")
    // Numeric entities: &#39; &#x27; etc.
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = parseInt(code, 10);
      return n > 0 && n < 0x10000 ? String.fromCharCode(n) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const n = parseInt(hex, 16);
      return n > 0 && n < 0x10000 ? String.fromCharCode(n) : "";
    })
    // Catch-all: any remaining &xxx; entities → strip
    .replace(/&[a-zA-Z]{2,8};/g, "")
    // Collapse multiple spaces (but preserve newlines)
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

/* ─── Gemini URL builders ───────────────────────── */
function geminiUrl(model: string, method: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${apiKey}`;
}

/** Convert Uint8Array → base64 without stack overflow and with correct padding.
 *  Builds the full binary string char-by-char (no spread operator), then btoa() once. */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/* ─── Text extraction: PDF via Gemini Flash ─────── */
async function extractTextFromPdf(
  apiKey: string,
  fileBytes: Uint8Array,
): Promise<string> {
  const base64 = uint8ToBase64(fileBytes);

  // Validate: %PDF → JVBERi in base64
  if (!base64.startsWith("JVBERi")) {
    throw new Error("PDF base64 non valido — il file potrebbe non essere un PDF");
  }

  const res = await fetch(geminiUrl(FLASH_MODEL, "generateContent", apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64,
            },
          },
          {
            text: `Sei un sistema di estrazione testo da documenti normativi italiani.
Estrai TUTTO il testo da questo PDF, mantenendo la struttura originale (titoli, articoli, commi, lettere, numeri).
NON riassumere, NON commentare — restituisci il testo integrale.
Se ci sono tabelle, convertile in formato testuale leggibile.`,
          },
        ],
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 30000,
      },
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini PDF extraction: ${payload?.error?.message || `HTTP ${res.status}`}`);
  }
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini non ha restituito testo dal PDF");
  return text.trim();
}

/* ─── Text extraction: URL via fetch + strip ────── */
async function extractTextFromUrl(
  apiKey: string,
  url: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let html: string;
  try {
    const res = await fetch(url, { signal: controller.signal });
    html = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  let text = stripHtml(html);

  // Fallback: if stripped text is too short, ask Gemini Flash
  if (text.length < 100) {
    console.log(`URL text too short (${text.length} chars), using Gemini Flash fallback`);
    const res = await fetch(geminiUrl(FLASH_MODEL, "generateContent", apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `Estrai il testo principale da questa pagina web normativa, ignorando navigazione, footer e sidebar:\n\n${html.substring(0, 50000)}`,
          }],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 16000 },
      }),
    });
    const payload = await res.json();
    if (res.ok) {
      text = payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || text;
    }
  }

  return text;
}

/* ─── Chunking ──────────────────────────────────── */
interface Chunk {
  content: string;
  section_title: string | null;
}

function detectSectionTitle(text: string): string | null {
  const firstLine = text.split("\n")[0]?.trim();
  if (!firstLine) return null;
  // Match patterns like "Art. 164", "CAPO III", "Comma 1", uppercase headers
  if (/^(Art\.|Articolo|CAPO|TITOLO|Sezione|Comma|Allegato|PARTE)\s/i.test(firstLine)) {
    return firstLine.length > 120 ? firstLine.substring(0, 120) : firstLine;
  }
  if (firstLine === firstLine.toUpperCase() && firstLine.length > 3 && firstLine.length < 120) {
    return firstLine;
  }
  return null;
}

function chunkText(text: string): Chunk[] {
  // If text is short enough, single chunk
  if (text.length <= CHUNK_TARGET_CHARS * 1.5) {
    return [{ content: text, section_title: detectSectionTitle(text) }];
  }

  const chunks: Chunk[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = offset + CHUNK_TARGET_CHARS;
    if (end >= text.length) {
      // Last chunk
      chunks.push({
        content: text.substring(offset),
        section_title: detectSectionTitle(text.substring(offset)),
      });
      break;
    }

    // Find best break point: prefer \n\n, then \n, then ". "
    let breakAt = -1;
    const searchRegion = text.substring(end - 400, end + 400);

    // Double newline
    const dn = searchRegion.lastIndexOf("\n\n");
    if (dn !== -1) {
      breakAt = end - 400 + dn + 2;
    } else {
      // Single newline
      const sn = searchRegion.lastIndexOf("\n");
      if (sn !== -1) {
        breakAt = end - 400 + sn + 1;
      } else {
        // Period + space
        const ps = searchRegion.lastIndexOf(". ");
        if (ps !== -1) {
          breakAt = end - 400 + ps + 2;
        } else {
          breakAt = end;
        }
      }
    }

    const chunkContent = text.substring(offset, breakAt);
    chunks.push({
      content: chunkContent,
      section_title: detectSectionTitle(chunkContent),
    });

    // Move forward with overlap
    offset = Math.max(offset + 1, breakAt - CHUNK_OVERLAP_CHARS);

    if (chunks.length >= MAX_CHUNKS) break;
  }

  return chunks;
}

/* ─── Embedding: sequential with 500ms pause ────── */
async function embedSingle(
  apiKey: string,
  text: string,
): Promise<number[]> {
  const res = await fetch(geminiUrl(EMBEDDING_MODEL, "embedContent", apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EMBEDDING_DIMS,
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`Embedding error: ${payload?.error?.message || `HTTP ${res.status}`}`);
  }
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS) {
    throw new Error(`Embedding dims ${values?.length}, expected ${EMBEDDING_DIMS}`);
  }
  return values.map(Number);
}

/* ─── Error helper: mark document as error ──────── */
async function markError(
  svc: ReturnType<typeof createClient>,
  docId: string,
  msg: string,
): Promise<void> {
  const errMsg = msg.length > 500 ? msg.substring(0, 500) : msg;
  await svc
    .from("kb_documents")
    .update({
      status: "error",
      processing_error: errMsg,
      error_message: errMsg,
    } as any)
    .eq("id", docId);
}

// ══════════════════════════════════════════════════
// ACTION: PROCESS — extract text + chunk + embed
// ══════════════════════════════════════════════════
async function handleProcess(
  svc: ReturnType<typeof createClient>,
  apiKey: string,
  documentId: string,
): Promise<Response> {
  // 1. Get document
  const { data: doc, error: docErr } = await svc
    .from("kb_documents")
    .select("*")
    .eq("id", documentId)
    .single();
  if (docErr || !doc) return jsonResponse({ error: "Documento non trovato" }, 404);

  // 2. Validate status
  if (doc.status !== "pending" && doc.status !== "error") {
    return jsonResponse({ error: `Documento già in stato '${doc.status}', non processabile` }, 400);
  }

  // 3. Set status → processing
  await svc
    .from("kb_documents")
    .update({ status: "processing", processing_error: null, error_message: null } as any)
    .eq("id", documentId);

  try {
    // 4. Extract text based on source_input_type
    let fullText = doc.full_text as string | null;
    const inputType = doc.source_input_type || doc.file_type || "text";

    if (inputType === "text") {
      // full_text should already be set — sanitize it
      if (fullText) fullText = sanitizeHtmlEntities(sanitizeText(fullText));
      if (!fullText || fullText.length < 10) {
        throw new Error("Nessun testo disponibile. Inserisci il testo nel campo full_text.");
      }
      console.log(`[process] Text input, ${fullText.length} chars already available`);
    } else if (inputType === "url") {
      const sourceUrl = doc.source_url as string;
      if (!sourceUrl) throw new Error("URL fonte mancante");
      console.log(`[process] Fetching URL: ${sourceUrl}`);
      fullText = sanitizeHtmlEntities(sanitizeText(await extractTextFromUrl(apiKey, sourceUrl)));
      // Save extracted text
      await svc
        .from("kb_documents")
        .update({ full_text: fullText } as any)
        .eq("id", documentId);
      console.log(`[process] URL text extracted: ${fullText.length} chars`);
    } else if (inputType === "pdf") {
      // Read from Supabase Storage
      const storagePath = doc.storage_path as string;
      if (!storagePath) throw new Error("PDF non caricato (storage_path mancante)");
      console.log(`[process] Downloading PDF from storage: ${storagePath}`);
      const { data: fileData, error: dlErr } = await svc.storage
        .from("kb-documents")
        .download(storagePath);
      if (dlErr || !fileData) {
        throw new Error(`Download PDF fallito: ${dlErr?.message || "file non trovato"}`);
      }
      const fileBytes = new Uint8Array(await fileData.arrayBuffer());
      console.log(`[process] PDF downloaded: ${fileBytes.length} bytes, extracting text...`);
      fullText = sanitizeHtmlEntities(sanitizeText(await extractTextFromPdf(apiKey, fileBytes)));
      // Save extracted text
      await svc
        .from("kb_documents")
        .update({ full_text: fullText } as any)
        .eq("id", documentId);
      console.log(`[process] PDF text extracted: ${fullText.length} chars`);
    } else {
      throw new Error(`Tipo input sconosciuto: ${inputType}`);
    }

    if (!fullText || fullText.length < 10) {
      throw new Error("Testo estratto vuoto o troppo corto");
    }

    // 5. Chunking
    await svc
      .from("kb_documents")
      .update({ status: "chunking" } as any)
      .eq("id", documentId);

    const chunks = chunkText(fullText);
    console.log(`[process] Created ${chunks.length} chunks`);

    // 6. Delete old chunks (in case of retry after error)
    await svc.from("kb_chunks").delete().eq("document_id", documentId);

    // 7. Embed and insert each chunk sequentially
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[process] Embedding chunk ${i + 1}/${chunks.length}...`);
      const embedding = await embedSingle(apiKey, chunk.content);

      const { error: insertErr } = await svc.from("kb_chunks").insert({
        document_id: documentId,
        chunk_index: i,
        content: sanitizeHtmlEntities(sanitizeText(chunk.content)),
        section_title: chunk.section_title,
        embedding: toVectorLiteral(embedding),
      } as any);

      if (insertErr) {
        throw new Error(`Insert chunk ${i} fallito: ${insertErr.message}`);
      }

      // 500ms pause between embeddings for rate limiting
      if (i < chunks.length - 1) {
        await sleep(500);
      }
    }

    // 8. Finalize
    await svc
      .from("kb_documents")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        processing_error: null,
        error_message: null,
      } as any)
      .eq("id", documentId);

    console.log(`[process] Document ${documentId} ready with ${chunks.length} chunks`);

    return jsonResponse({
      status: "ok",
      document_id: documentId,
      chunks: chunks.length,
      text_length: fullText.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[process] Error: ${msg}`);
    // Cleanup partial chunks
    await svc.from("kb_chunks").delete().eq("document_id", documentId);
    await markError(svc, documentId, msg);
    return jsonResponse({ error: msg }, 500);
  }
}

// ══════════════════════════════════════════════════
// ACTION: REPROCESS — re-sanitize full_text, delete old chunks, re-chunk + re-embed
// (No re-extraction from source — uses already-saved full_text)
// ══════════════════════════════════════════════════
async function handleReprocess(
  svc: ReturnType<typeof createClient>,
  apiKey: string,
  documentId: string,
): Promise<Response> {
  // 1. Get document
  const { data: doc, error: docErr } = await svc
    .from("kb_documents")
    .select("*")
    .eq("id", documentId)
    .single();
  if (docErr || !doc) return jsonResponse({ error: "Documento non trovato" }, 404);

  let fullText = doc.full_text as string | null;
  if (!fullText || fullText.length < 10) {
    return jsonResponse({ error: "Nessun full_text salvato. Usa action: process per estrarre il testo." }, 400);
  }

  // 2. Set status → processing
  await svc
    .from("kb_documents")
    .update({ status: "processing", processing_error: null, error_message: null } as any)
    .eq("id", documentId);

  try {
    // 3. Re-sanitize full_text (apply new sanitizeHtmlEntities)
    fullText = sanitizeHtmlEntities(sanitizeText(fullText));
    await svc
      .from("kb_documents")
      .update({ full_text: fullText, status: "chunking" } as any)
      .eq("id", documentId);
    console.log(`[reprocess] Sanitized full_text: ${fullText.length} chars`);

    // 4. Re-chunk
    const chunks = chunkText(fullText);
    console.log(`[reprocess] Created ${chunks.length} chunks`);

    // 5. Delete old chunks
    await svc.from("kb_chunks").delete().eq("document_id", documentId);

    // 6. Embed + insert each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`[reprocess] Embedding chunk ${i + 1}/${chunks.length}...`);
      const embedding = await embedSingle(apiKey, sanitizeHtmlEntities(sanitizeText(chunk.content)));

      const { error: insertErr } = await svc.from("kb_chunks").insert({
        document_id: documentId,
        chunk_index: i,
        content: sanitizeHtmlEntities(sanitizeText(chunk.content)),
        section_title: chunk.section_title,
        embedding: toVectorLiteral(embedding),
      } as any);

      if (insertErr) {
        throw new Error(`Insert chunk ${i} fallito: ${insertErr.message}`);
      }

      if (i < chunks.length - 1) await sleep(500);
    }

    // 7. Finalize
    await svc
      .from("kb_documents")
      .update({
        status: "ready",
        chunk_count: chunks.length,
        processing_error: null,
        error_message: null,
      } as any)
      .eq("id", documentId);

    console.log(`[reprocess] Document ${documentId} reprocessed: ${chunks.length} chunks`);

    return jsonResponse({
      status: "ok",
      document_id: documentId,
      chunks: chunks.length,
      text_length: fullText.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[reprocess] Error: ${msg}`);
    await svc.from("kb_chunks").delete().eq("document_id", documentId);
    await markError(svc, documentId, msg);
    return jsonResponse({ error: msg }, 500);
  }
}

// ══════════════════════════════════════════════════
// ACTION: CLASSIFY — AI metadata via Gemini (model from agent_config)
// ══════════════════════════════════════════════════
async function handleClassify(
  svc: ReturnType<typeof createClient>,
  apiKey: string,
  documentId: string,
): Promise<Response> {
  // 1. Get document
  const { data: doc, error: docErr } = await svc
    .from("kb_documents")
    .select("*")
    .eq("id", documentId)
    .single();
  if (docErr || !doc) return jsonResponse({ error: "Documento non trovato" }, 404);

  // 2. Validate: full_text must exist
  const fullText = doc.full_text as string | null;
  if (!fullText || fullText.length < 10) {
    return jsonResponse({
      error: "Il documento non ha testo. Processalo prima (action: process).",
    }, 400);
  }

  // 3. Load existing docs and rules for relation suggestions
  const { data: existingDocs } = await svc
    .from("kb_documents")
    .select("id, title, legal_reference, category")
    .eq("active", true)
    .neq("id", documentId)
    .limit(200);

  const { data: existingRules } = await svc
    .from("knowledge_base")
    .select("id, title, domain")
    .eq("active", true)
    .limit(100);

  const docsCtx = (existingDocs || [])
    .map((d: any) => `- [${d.id}] ${d.title} (${d.legal_reference || "N/A"})`)
    .join("\n");

  const rulesCtx = (existingRules || [])
    .map((r: any) => `- [${r.id}] ${r.title} (${r.domain})`)
    .join("\n");

  // 4. Build classification prompt
  const classificationPrompt = `Sei un esperto di diritto tributario e contabilità italiana con 30 anni di esperienza. Ti viene dato il testo di un documento normativo. Devi analizzarlo e classificarlo con metadata strutturata.

DOCUMENTO:
Titolo: ${doc.title || "(senza titolo)"}
Tipo fonte: ${doc.source_type || "non specificato"}
Categoria attuale: ${doc.category || "non specificata"}

TESTO:
${fullText.substring(0, 30000)}

DOCUMENTI GIÀ PRESENTI NEL KNOWLEDGE BASE (per suggerire relazioni):
${docsCtx || "(nessuno)"}

REGOLE GIÀ PRESENTI NEL KNOWLEDGE BASE:
${rulesCtx || "(nessuna)"}

Restituisci un JSON con questa struttura:
{
  "category": "string — una tra: normativa_fiscale, principi_contabili, principi_revisione, prassi_interpretativa, normativa_periodica, giurisprudenza, tabelle_operative, normativa_lavoro, normativa_societaria",

  "source_type": "string — una tra: legge, dpr, dlgs, dm, dpcm, circolare_ade, risoluzione_ade, interpello_ade, principio_oic, principio_isa, sentenza, prassi, normativa_eu, altro",

  "authority": "string — una tra: tuir, dpr_633, dpr_600, codice_civile, oic, isa_italia, agenzia_entrate, mef, cassazione, corte_costituzionale, commissione_tributaria, cndcec, eu, altro",

  "subcategory": "string — sottocategoria tematica (es. 'ammortamento', 'reverse_charge', 'leasing', 'veicoli', 'rappresentanza')",

  "tax_area": ["array di aree fiscali tra: imposte_dirette, iva, irap, ritenute, imu, imposta_registro"],

  "accounting_area": ["array di aree contabili tra: bilancio, ammortamento, fondi_rischi, ratei_risconti, conto_economico, stato_patrimoniale"],

  "topic_tags": ["tag tematici tra: veicoli, immobili, leasing, rappresentanza, telefonia, carburanti, reverse_charge, split_payment, intrastat, professionisti, beni_strumentali, omaggi, vitto_alloggio, interessi_passivi, perdite_su_crediti, ammortamento, ritenuta_acconto, contributi_previdenziali, operazioni_esenti, autofattura, nota_credito, fatturazione_elettronica — puoi aggiungerne di nuovi se nessuno è adatto"],

  "applies_to_legal_forms": ["srl","spa","sapa","snc","sas","ditta_individuale","cooperativa","associazione","ente_non_commerciale"] | null,

  "applies_to_regimes": ["ordinario","semplificato","forfettario"] | null,

  "applies_to_ateco_prefixes": ["08","41","43","F"] | null,

  "applies_to_operations": ["acquisto_beni_strumentali","leasing","noleggio","servizi","cessione","prestazione_professionale","rimborso_spese","autofattura"] | null,

  "applies_to_counterparty": ["fornitore_it","professionista","fornitore_ue","fornitore_extraue","pa","banca","assicurazione","forfettario"] | null,

  "applies_to_size": ["micro","piccola","media","grande"] | null,

  "amount_threshold_min": number | null,
  "amount_threshold_max": number | null,

  "effective_from": "YYYY-MM-DD",
  "effective_until": "YYYY-MM-DD" | null,
  "update_frequency": "static" | "annual" | "periodic" | "volatile",

  "summary": "Riassunto in 2-3 frasi: cosa stabilisce il documento e a chi si applica.",

  "suggested_relations": [
    {
      "target_id": "uuid",
      "target_type": "document" | "rule",
      "relation_type": "rinvia_a" | "modifica" | "interpreta" | "abroga" | "attua" | "deroga" | "integra" | "cita",
      "note": "breve spiegazione"
    }
  ]
}

REGOLE DI CLASSIFICAZIONE:
- Campi applies_to_*: null = si applica a TUTTI. Metti un array SOLO se il documento si applica esclusivamente a specifiche forme/regimi/settori.
- Sii CONSERVATIVO con i filtri di applicabilità: null è meglio di un array incompleto
- Sii GENEROSO con topic_tags: meglio più tag pertinenti che pochi
- amount_threshold_min/max: SOLO se il documento menziona esplicitamente soglie legali con importi specifici
- effective_from: usa la data di pubblicazione se non c'è data esplicita di entrata in vigore
- suggested_relations: suggerisci SOLO relazioni chiare ed evidenti, non forzare connessioni deboli
- Per documenti fiscali generali (es. art. 109 TUIR inerenza): applies_to_* tutto null perché si applica a tutti`;

  // 5. Read model + thinking config from agent_config (kb_classifier)
  let classifyModel = DEFAULT_PRO_MODEL;
  let thinkingBudget = DEFAULT_THINKING_BUDGET;
  let maxOutputTokens = 8192;
  try {
    const { data: kbConfig } = await svc
      .from("agent_config")
      .select("model, thinking_budget, max_output_tokens")
      .eq("agent_type", "kb_classifier")
      .eq("active", true)
      .single();
    if (kbConfig) {
      classifyModel = (kbConfig as any).model || DEFAULT_PRO_MODEL;
      thinkingBudget = (kbConfig as any).thinking_budget ?? DEFAULT_THINKING_BUDGET;
      maxOutputTokens = (kbConfig as any).max_output_tokens || 8192;
    }
  } catch (e) {
    console.warn("[classify] agent_config read failed, using defaults:", e);
  }

  // Build generationConfig with optional thinkingConfig
  // NOTE: responseMimeType: "application/json" silently disables thinking on Gemini 2.5 Pro!
  // We parse JSON from text instead.
  const genConfig: Record<string, unknown> = {
    temperature: 0.1,
    maxOutputTokens,
  };
  if (thinkingBudget > 0 && !NO_THINKING_CONFIG_MODELS.includes(classifyModel)) {
    genConfig.thinkingConfig = { thinkingBudget };
  }

  console.log(`[classify] Calling ${classifyModel} (thinking=${thinkingBudget}) for document ${documentId}...`);
  const classifyRes = await fetch(
    geminiUrl(classifyModel, "generateContent", apiKey),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{ text: classificationPrompt }],
        }],
        generationConfig: genConfig,
      }),
    },
  );

  const classifyPayload = await classifyRes.json();
  if (!classifyRes.ok) {
    const msg = classifyPayload?.error?.message || `HTTP ${classifyRes.status}`;
    return jsonResponse({ error: `Gemini ${classifyModel} classification failed: ${msg}` }, 500);
  }

  // 6. Parse JSON response — extract thinking parts + parse JSON from text
  let classification: any;
  try {
    const parts = classifyPayload?.candidates?.[0]?.content?.parts || [];
    // Separate thinking from content
    const thinkingParts = parts.filter((p: any) => p.thought === true);
    const textParts = parts.filter((p: any) => !p.thought && p.text);
    const thinkingText = thinkingParts.map((p: any) => p.text || "").join("\n");
    const responseText = textParts.map((p: any) => p.text || "").join("\n");

    if (thinkingText) {
      console.log(`[classify] Thinking: ${thinkingText.length} chars — ${thinkingText.slice(0, 200)}...`);
    }
    console.log(`[classify] Response text: ${responseText.length} chars`);

    if (!responseText) throw new Error("No text in response");

    // Strip markdown fences and parse JSON
    const cleanText = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    try {
      classification = JSON.parse(cleanText);
    } catch {
      // Try extracting JSON object from the text
      const objMatch = cleanText.match(/\{[\s\S]*\}/);
      if (objMatch) {
        classification = JSON.parse(objMatch[0]);
      } else {
        throw new Error("No JSON object found in response");
      }
    }
  } catch (e) {
    console.error("[classify] Failed to parse JSON response:", e);
    return jsonResponse({ error: "AI non ha restituito JSON valido" }, 500);
  }

  console.log(`[classify] Classification received, updating document...`);

  // 7. Update only empty/null fields (preserve manual edits)
  const fieldsUpdated: string[] = [];
  const fieldsSkipped: string[] = [];
  const updates: Record<string, any> = {};

  function maybeUpdate(
    fieldName: string,
    currentValue: any,
    newValue: any,
  ): void {
    const isEmpty =
      currentValue === null ||
      currentValue === undefined ||
      currentValue === "" ||
      (Array.isArray(currentValue) && currentValue.length === 0);

    if (isEmpty && newValue !== null && newValue !== undefined) {
      updates[fieldName] = newValue;
      fieldsUpdated.push(fieldName);
    } else {
      fieldsSkipped.push(fieldName);
    }
  }

  maybeUpdate("category", doc.category, classification.category);
  maybeUpdate("source_type", doc.source_type, classification.source_type);
  maybeUpdate("authority", doc.authority, classification.authority);
  maybeUpdate("subcategory", doc.subcategory, classification.subcategory);
  maybeUpdate("tax_area", doc.tax_area, classification.tax_area);
  maybeUpdate("accounting_area", doc.accounting_area, classification.accounting_area);
  maybeUpdate("topic_tags", doc.topic_tags, classification.topic_tags);
  maybeUpdate("applies_to_legal_forms", doc.applies_to_legal_forms, classification.applies_to_legal_forms);
  maybeUpdate("applies_to_regimes", doc.applies_to_regimes, classification.applies_to_regimes);
  maybeUpdate("applies_to_ateco_prefixes", doc.applies_to_ateco_prefixes, classification.applies_to_ateco_prefixes);
  maybeUpdate("applies_to_operations", doc.applies_to_operations, classification.applies_to_operations);
  maybeUpdate("applies_to_counterparty", doc.applies_to_counterparty, classification.applies_to_counterparty);
  maybeUpdate("applies_to_size", doc.applies_to_size, classification.applies_to_size);
  maybeUpdate("amount_threshold_min", doc.amount_threshold_min, classification.amount_threshold_min);
  maybeUpdate("amount_threshold_max", doc.amount_threshold_max, classification.amount_threshold_max);
  maybeUpdate("effective_from", doc.effective_from === "2000-01-01" ? null : doc.effective_from, classification.effective_from);
  maybeUpdate("effective_until", doc.effective_until, classification.effective_until);
  maybeUpdate("update_frequency", doc.update_frequency === "static" ? null : doc.update_frequency, classification.update_frequency);
  maybeUpdate("summary", doc.summary, classification.summary);

  if (Object.keys(updates).length > 0) {
    const { error: updateErr } = await svc
      .from("kb_documents")
      .update(updates as any)
      .eq("id", documentId);
    if (updateErr) {
      console.error(`[classify] Update error: ${updateErr.message}`);
      return jsonResponse({ error: `Aggiornamento fallito: ${updateErr.message}` }, 500);
    }
  }

  console.log(
    `[classify] Updated ${fieldsUpdated.length} fields, skipped ${fieldsSkipped.length}`,
  );

  // 8. Return classification + suggested_relations for frontend review
  return jsonResponse({
    status: "ok",
    classification,
    fields_updated: fieldsUpdated,
    fields_skipped: fieldsSkipped,
    suggested_relations: classification.suggested_relations || [],
    suggested_relations_count: (classification.suggested_relations || []).length,
  });
}

// ══════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const apiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();

  if (!apiKey) return jsonResponse({ error: "GEMINI_API_KEY non configurata" }, 500);
  if (!serviceRoleKey) return jsonResponse({ error: "SUPABASE_SERVICE_ROLE_KEY non configurata" }, 500);

  // Auth: accept user bearer token
  const bearer = getBearerToken(req);
  if (!bearer) return jsonResponse({ error: "Non autorizzato" }, 401);

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    document_id?: string;
  };

  const action = body.action || "process"; // default to process for backward compatibility
  const documentId = body.document_id;

  if (!documentId) return jsonResponse({ error: "document_id è richiesto" }, 400);
  if (!["process", "classify", "reprocess"].includes(action)) {
    return jsonResponse({ error: "action deve essere 'process', 'classify' o 'reprocess'" }, 400);
  }

  // Service client for all DB operations
  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "process") {
      return await handleProcess(svc, apiKey, documentId);
    } else if (action === "reprocess") {
      return await handleReprocess(svc, apiKey, documentId);
    } else {
      return await handleClassify(svc, apiKey, documentId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[kb-process-document] Unhandled error: ${msg}`);
    await markError(svc, documentId, msg);
    return jsonResponse({ error: msg }, 500);
  }
});
