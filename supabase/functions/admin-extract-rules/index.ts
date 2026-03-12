// admin-extract-rules — Extracts structured fiscal rules from a processed KB document.
// Loads chunks from kb_chunks for a given document_id, sends them to Gemini,
// and returns candidate rules for admin review before insertion into knowledge_base.

import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Types ──────────────────────────────── */

interface CandidateRule {
  domain: string;
  audience: string;
  title: string;
  content: string;
  normativa_ref: string[];
  fiscal_values: Record<string, unknown>;
  trigger_keywords: string[];
  trigger_ateco_prefixes: string[];
  trigger_vat_natures: string[];
  trigger_doc_types: string[];
  priority: number;
}

/* ─── Extract JSON ─────────────────────── */

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/* ─── Main ───────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);

  let body: {
    document_id?: string;
    company_id?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }

  const documentId = body.document_id;
  const companyId = body.company_id;

  if (!documentId) return json({ error: "document_id richiesto" }, 400);
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // Verify document exists and is ready
    const [doc] = await sql`
      SELECT id, title, file_name, status, metadata
      FROM kb_documents
      WHERE id = ${documentId} AND company_id = ${companyId}
      LIMIT 1`;

    if (!doc) {
      await sql.end();
      return json({ error: "Documento non trovato" }, 404);
    }
    if (doc.status !== "ready") {
      await sql.end();
      return json({ error: `Documento non pronto (status: ${doc.status})` }, 400);
    }

    // Load all chunks for this document
    const chunks = await sql`
      SELECT chunk_index, content, section_title, article_reference, token_count
      FROM kb_chunks
      WHERE document_id = ${documentId}
      ORDER BY chunk_index`;

    if (chunks.length === 0) {
      await sql.end();
      return json({ error: "Nessun chunk trovato per questo documento" }, 400);
    }

    console.log(`[admin-extract-rules] Document "${doc.title}" — ${chunks.length} chunks, total tokens: ${chunks.reduce((s: number, c: any) => s + (c.token_count || 0), 0)}`);

    // Build the document text for Gemini (concatenate all chunks)
    const documentText = chunks.map((c: any, i: number) => {
      const header = c.section_title ? `[Sezione: ${c.section_title}]` : "";
      const ref = c.article_reference ? ` (Art. ${c.article_reference})` : "";
      return `--- Chunk ${i + 1}${header}${ref} ---\n${c.content}`;
    }).join("\n\n");

    // Truncate if too large (Gemini context is large but let's be reasonable)
    const maxChars = 80000;
    const truncatedText = documentText.length > maxChars
      ? documentText.slice(0, maxChars) + "\n\n[... documento troncato ...]"
      : documentText;

    // Build extraction prompt
    const prompt = `Sei un esperto fiscale italiano. Analizza il seguente documento e estrai REGOLE FISCALI strutturate.

DOCUMENTO: "${doc.title}" (${doc.file_name})

${truncatedText}

===

COMPITO: Estrai regole fiscali applicabili dalla normativa italiana contenuta in questo documento.

Per ogni regola, restituisci un oggetto con:
- domain: uno tra "iva", "ires_irap", "ritenute", "classificazione", "settoriale", "operativo", "aggiornamenti"
- audience: uno tra "commercialista", "revisore", "both"
- title: titolo breve della regola (max 80 caratteri)
- content: testo della regola con dettagli pratici (max 500 caratteri)
- normativa_ref: array di riferimenti normativi (es. ["Art. 19 DPR 633/72", "Circolare AdE 7/2024"])
- fiscal_values: oggetto con valori fiscali quantitativi (es. {"deducibilita_pct": 20, "soglia_bene_strumentale": 516.46})
- trigger_keywords: array di parole chiave che attivano questa regola (es. ["autovettura", "automobile", "auto aziendale"])
- trigger_ateco_prefixes: array di prefissi ATECO rilevanti (es. ["41", "42", "43"] per edilizia). Vuoto se generale.
- trigger_vat_natures: array di nature IVA (es. ["N6.1", "N6.7"]). Vuoto se generale.
- trigger_doc_types: array di tipi documento (es. ["TD16", "TD17"]). Vuoto se generale.
- priority: 1-100 (più alto = più prioritario)

REGOLE DI ESTRAZIONE:
- Estrai SOLO regole con implicazioni PRATICHE per la classificazione contabile
- NON estrarre definizioni generiche, storia legislativa o considerazioni teoriche
- Ogni regola deve essere AZIONABILE da un commercialista
- I fiscal_values devono contenere NUMERI concreti (percentuali, soglie)
- I trigger_keywords devono essere specifici (non generici come "fattura" o "iva")
- Cerca di estrarre almeno 3-5 regole se il documento le contiene
- Se il documento non contiene regole fiscali applicabili, restituisci un array vuoto

Rispondi SOLO con il JSON array (no markdown, no commento):
[{...}]`;

    // Call Gemini
    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 16384,
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      await sql.end();
      return json({ error: `Gemini API ${resp.status}: ${errText.slice(0, 300)}` }, 502);
    }

    const data = await resp.json();
    const gParts = (data as any)?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of gParts) { if (part.text && !part.thought) responseText += part.text; }

    // Parse candidates
    const jsonStr = extractFirstJsonArray(responseText);
    let candidates: CandidateRule[] = [];
    if (jsonStr) {
      try { candidates = JSON.parse(jsonStr); } catch (e) {
        console.error("[admin-extract-rules] JSON parse error:", e);
      }
    }

    // Validate candidates
    const validDomains = ["iva", "ires_irap", "ritenute", "classificazione", "settoriale", "operativo", "aggiornamenti"];
    const validAudiences = ["commercialista", "revisore", "both"];
    candidates = candidates.filter((c) => {
      if (!c.title || !c.content) return false;
      if (!validDomains.includes(c.domain)) c.domain = "classificazione";
      if (!validAudiences.includes(c.audience)) c.audience = "both";
      if (!Array.isArray(c.normativa_ref)) c.normativa_ref = [];
      if (!c.fiscal_values || typeof c.fiscal_values !== "object") c.fiscal_values = {};
      if (!Array.isArray(c.trigger_keywords)) c.trigger_keywords = [];
      if (!Array.isArray(c.trigger_ateco_prefixes)) c.trigger_ateco_prefixes = [];
      if (!Array.isArray(c.trigger_vat_natures)) c.trigger_vat_natures = [];
      if (!Array.isArray(c.trigger_doc_types)) c.trigger_doc_types = [];
      if (typeof c.priority !== "number") c.priority = 50;
      return true;
    });

    console.log(`[admin-extract-rules] Extracted ${candidates.length} candidate rules from "${doc.title}"`);

    await sql.end();

    return json({
      candidates,
      document: {
        id: doc.id,
        title: doc.title,
        file_name: doc.file_name,
        chunks_count: chunks.length,
      },
      _debug: {
        model_used: model,
        prompt_length: prompt.length,
        document_chars: truncatedText.length,
        raw_response_length: responseText.length,
      },
    });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
