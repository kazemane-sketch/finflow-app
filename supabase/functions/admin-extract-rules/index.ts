// admin-extract-rules — Extracts consultive KB notes from a processed KB document.
// Loads chunks from kb_chunks for a given document_id, sends them to Gemini,
// and returns candidate notes for admin review before insertion into knowledge_base.

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

interface CandidateNote {
  knowledge_kind: "advisory_note" | "numeric_fact";
  domain: string;
  audience: string;
  title: string;
  content: string;
  summary_structured: {
    question?: string;
    short_answer?: string;
    applies_when?: string[];
    not_when?: string[];
    missing_info?: string[];
    numeric_facts?: Record<string, number | string>;
    source_refs?: string[];
  };
  applicability?: {
    applies_to_ateco_prefixes?: string[];
    applies_to_operations?: string[];
    applies_to_counterparty?: string[];
    amount_threshold_min?: number | null;
    amount_threshold_max?: number | null;
  };
  normativa_ref: string[];
  source_chunk_ids: string[];
  priority: number;
  fiscal_values?: Record<string, unknown>;
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const trimmed = String(value).trim();
  return trimmed ? [trimmed] : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY non configurata" }, 503);

  let body: { document_id?: string; company_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const documentId = body.document_id;
  const companyId = body.company_id;
  if (!documentId) return json({ error: "document_id richiesto" }, 400);
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const sql = postgres(dbUrl, { max: 1 });

  try {
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

    const chunks = await sql`
      SELECT id, chunk_index, content, section_title, article_reference, token_count
      FROM kb_chunks
      WHERE document_id = ${documentId}
      ORDER BY chunk_index`;

    if (chunks.length === 0) {
      await sql.end();
      return json({ error: "Nessun chunk trovato per questo documento" }, 400);
    }

    console.log(
      `[admin-extract-rules] Document "${doc.title}" — ${chunks.length} chunks, total tokens: ${
        chunks.reduce((sum: number, chunk: any) => sum + (chunk.token_count || 0), 0)
      }`,
    );

    const documentText = chunks.map((chunk: any, index: number) => {
      const header = chunk.section_title ? ` | sezione=${chunk.section_title}` : "";
      const ref = chunk.article_reference ? ` | ref=${chunk.article_reference}` : "";
      return `--- CHUNK ${index + 1} | id=${chunk.id}${header}${ref} ---\n${chunk.content}`;
    }).join("\n\n");

    const maxChars = 90000;
    const truncatedText = documentText.length > maxChars
      ? documentText.slice(0, maxChars) + "\n\n[... documento troncato ...]"
      : documentText;

    const prompt = `Sei un consulente fiscale-contabile italiano senior.
Analizza il seguente documento e produci NOTE CONSULTIVE per una knowledge base aziendale. Non produrre regole imperative.

DOCUMENTO: "${doc.title}" (${doc.file_name})

${truncatedText}

===

COMPITO
- Estrai schede utili a orientare il giudizio professionale di commercialista, revisore e consulente.
- Ogni scheda deve aiutare a capire quando una conclusione e plausibile, quando NON basta e quali dati mancano.
- Se il documento contiene solo valori numerici/limiti molto chiari, puoi usare knowledge_kind="numeric_fact"; altrimenti usa "advisory_note".

Per ogni nota restituisci:
- knowledge_kind: "advisory_note" oppure "numeric_fact"
- domain: uno tra "iva", "ires_irap", "ritenute", "classificazione", "settoriale", "operativo", "aggiornamenti"
- audience: "commercialista", "revisore" oppure "both"
- title: titolo breve (max 80 caratteri)
- content: sintesi leggibile per umano (max 500 caratteri)
- summary_structured: oggetto con
  - question: domanda a cui risponde la nota
  - short_answer: risposta breve
  - applies_when: array di condizioni tipiche in cui la nota e rilevante
  - not_when: array di condizioni in cui NON va usata
  - missing_info: array di dati che spesso mancano per decidere davvero
  - numeric_facts: oggetto con percentuali/soglie/date rilevanti
  - source_refs: array di riferimenti sintetici
- applicability: oggetto opzionale con
  - applies_to_ateco_prefixes: array
  - applies_to_operations: array (es. ["leasing","banca","assicurazione","veicoli","servizi"])
  - applies_to_counterparty: array (es. ["banca","pa","professionista"])
  - amount_threshold_min / amount_threshold_max
- normativa_ref: array di riferimenti normativi
- source_chunk_ids: array di id chunk realmente usati come supporto
- priority: 1-100

REGOLE DI ESTRAZIONE
- NON scrivere ordini assoluti tipo "devi sempre", "mai" se il documento lascia eccezioni o condizioni.
- Evidenzia le nuance in applies_when, not_when e missing_info.
- Usa source_chunk_ids reali presi dagli header CHUNK del documento.
- Non inventare chunk id o riferimenti normativi.
- Se il documento non contiene materiale utile, restituisci [].

Rispondi SOLO con il JSON array (no markdown, no commenti).`;

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
    const parts = data?.candidates?.[0]?.content?.parts || [];
    let responseText = "";
    for (const part of parts) {
      if (part.text && !part.thought) responseText += part.text;
    }

    const jsonStr = extractFirstJsonArray(responseText);
    let candidates: CandidateNote[] = [];
    if (jsonStr) {
      try {
        candidates = JSON.parse(jsonStr);
      } catch (error) {
        console.error("[admin-extract-rules] JSON parse error:", error);
      }
    }

    const validDomains = ["iva", "ires_irap", "ritenute", "classificazione", "settoriale", "operativo", "aggiornamenti"];
    const validAudiences = ["commercialista", "revisore", "both"];
    const validChunkIds = new Set(chunks.map((chunk: any) => String(chunk.id)));

    candidates = candidates.filter((candidate) => candidate && typeof candidate === "object").map((candidate) => {
      const summaryStructured = asObject(candidate.summary_structured);
      const applicability = asObject(candidate.applicability);
      const numericFacts = asObject(summaryStructured.numeric_facts);

      const normalized: CandidateNote = {
        knowledge_kind: candidate.knowledge_kind === "numeric_fact" ? "numeric_fact" : "advisory_note",
        domain: validDomains.includes(candidate.domain) ? candidate.domain : "classificazione",
        audience: validAudiences.includes(candidate.audience) ? candidate.audience : "both",
        title: String(candidate.title || "").trim(),
        content: String(candidate.content || summaryStructured.short_answer || "").trim(),
        summary_structured: {
          question: String(summaryStructured.question || "").trim(),
          short_answer: String(summaryStructured.short_answer || candidate.content || "").trim(),
          applies_when: asStringArray(summaryStructured.applies_when),
          not_when: asStringArray(summaryStructured.not_when),
          missing_info: asStringArray(summaryStructured.missing_info),
          numeric_facts: Object.fromEntries(
            Object.entries(numericFacts).filter(([, value]) => ["string", "number"].includes(typeof value)),
          ),
          source_refs: asStringArray(summaryStructured.source_refs),
        },
        applicability: {
          applies_to_ateco_prefixes: asStringArray(applicability.applies_to_ateco_prefixes),
          applies_to_operations: asStringArray(applicability.applies_to_operations),
          applies_to_counterparty: asStringArray(applicability.applies_to_counterparty),
          amount_threshold_min: Number.isFinite(Number(applicability.amount_threshold_min))
            ? Number(applicability.amount_threshold_min)
            : null,
          amount_threshold_max: Number.isFinite(Number(applicability.amount_threshold_max))
            ? Number(applicability.amount_threshold_max)
            : null,
        },
        normativa_ref: asStringArray(candidate.normativa_ref),
        source_chunk_ids: asStringArray(candidate.source_chunk_ids).filter((id) => validChunkIds.has(id)).slice(0, 8),
        priority: Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : 50,
        fiscal_values: Object.fromEntries(
          Object.entries(numericFacts).filter(([, value]) => ["string", "number"].includes(typeof value)),
        ),
      };
      return normalized;
    }).filter((candidate) =>
      Boolean(candidate.title) &&
      Boolean(candidate.content) &&
      candidate.source_chunk_ids.length > 0
    );

    console.log(`[admin-extract-rules] Extracted ${candidates.length} candidate notes from "${doc.title}"`);

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
