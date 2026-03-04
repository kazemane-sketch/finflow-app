import { createClient } from "npm:@supabase/supabase-js@2";

/* ─── CORS ───────────────────────────────── */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ─── Config ─────────────────────────────── */
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMS = 3072;
const CHUNK_TARGET_WORDS = 600;
const CHUNK_MAX_WORDS = 800;
const CHUNK_OVERLAP_WORDS = 100;
const MAX_CHUNKS = 200; // safety cap

/* ─── Helpers ────────────────────────────── */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

/* ─── Text extraction ────────────────────── */

async function extractTextFromPdf(
  geminiKey: string,
  fileBytes: Uint8Array,
): Promise<string> {
  const base64 = btoa(String.fromCharCode(...fileBytes));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
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
                data: base64,
              },
            },
            {
              text: "Estrai tutto il testo dal documento PDF. Restituisci SOLO il testo estratto, senza commenti, senza formattazione markdown, senza intestazioni aggiunte. Mantieni la struttura originale con paragrafi e a capo.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 30000,
      },
    }),
  });

  const payload = await res.json();
  if (!res.ok) {
    const msg = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini PDF extraction error: ${msg}`);
  }

  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== "string") {
    throw new Error("Gemini non ha restituito testo dal PDF");
  }
  return text.trim();
}

function extractTextFromPlain(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).trim();
}

/* ─── Chunking ───────────────────────────── */

function chunkText(text: string): string[] {
  // Split into paragraphs, then group into chunks of ~CHUNK_TARGET_WORDS
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const para of paragraphs) {
    const paraWords = para.split(/\s+/).length;

    // If single paragraph exceeds max, split by sentences
    if (paraWords > CHUNK_MAX_WORDS) {
      // Flush current
      if (current.length > 0) {
        chunks.push(current.join("\n\n"));
        current = [];
        currentWords = 0;
      }
      // Split long paragraph by sentences
      const sentences = para.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [para];
      let sentBuf: string[] = [];
      let sentWords = 0;
      for (const sent of sentences) {
        const sw = sent.split(/\s+/).length;
        if (sentWords + sw > CHUNK_TARGET_WORDS && sentBuf.length > 0) {
          chunks.push(sentBuf.join(" "));
          // Overlap: keep last sentence
          const overlapSent = sentBuf.slice(-1);
          sentBuf = [...overlapSent, sent];
          sentWords = overlapSent.join(" ").split(/\s+/).length + sw;
        } else {
          sentBuf.push(sent);
          sentWords += sw;
        }
      }
      if (sentBuf.length > 0) {
        chunks.push(sentBuf.join(" "));
      }
      continue;
    }

    if (currentWords + paraWords > CHUNK_TARGET_WORDS && current.length > 0) {
      chunks.push(current.join("\n\n"));
      // Overlap: keep last paragraph if small enough
      const lastPara = current[current.length - 1];
      const lastWords = lastPara.split(/\s+/).length;
      if (lastWords <= CHUNK_OVERLAP_WORDS) {
        current = [lastPara, para];
        currentWords = lastWords + paraWords;
      } else {
        current = [para];
        currentWords = paraWords;
      }
    } else {
      current.push(para);
      currentWords += paraWords;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  // Safety cap
  return chunks.slice(0, MAX_CHUNKS);
}

/* ─── Embeddings ─────────────────────────── */

async function embedChunks(
  geminiKey: string,
  texts: string[],
): Promise<number[][]> {
  // Gemini batchEmbedContents supports up to 100 texts per call
  const allEmbeddings: number[][] = [];
  const batchSize = 100;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${geminiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: batch.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBEDDING_DIMS,
        })),
      }),
    });

    const payload = await res.json();
    if (!res.ok) {
      const msg = payload?.error?.message || `HTTP ${res.status}`;
      throw new Error(`Gemini batch embedding error: ${msg}`);
    }

    const embeddings = payload?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Gemini returned ${embeddings?.length ?? 0} embeddings, expected ${batch.length}`);
    }

    for (const emb of embeddings) {
      const values = emb?.values;
      if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS) {
        throw new Error(`Embedding dims ${values?.length}, expected ${EMBEDDING_DIMS}`);
      }
      allEmbeddings.push(values.map(Number));
    }
  }

  return allEmbeddings;
}

/* ─── Main handler ───────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim();

  if (!geminiKey) return jsonResponse({ error: "GEMINI_API_KEY non configurata" }, 500);
  if (!serviceRoleKey) return jsonResponse({ error: "SUPABASE_SERVICE_ROLE_KEY non configurata" }, 500);

  // Auth: accept user bearer token (the function uses service_role internally)
  const bearer = getBearerToken(req);
  if (!bearer) return jsonResponse({ error: "Non autorizzato" }, 401);

  const body = await req.json().catch(() => ({})) as {
    document_id?: string;
    company_id?: string;
  };

  const documentId = body.document_id;
  const companyId = body.company_id;
  if (!documentId || !companyId) {
    return jsonResponse({ error: "document_id e company_id richiesti" }, 400);
  }

  // Service client for internal operations
  const svc = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // User client to verify membership
  const userClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });

  try {
    // 1. Verify user is company member
    const { data: membership } = await userClient
      .from("company_members")
      .select("user_id")
      .eq("company_id", companyId)
      .limit(1)
      .single();
    if (!membership) return jsonResponse({ error: "Non autorizzato per questa azienda" }, 403);

    // 2. Get document record
    const { data: doc, error: docErr } = await svc
      .from("kb_documents")
      .select("*")
      .eq("id", documentId)
      .eq("company_id", companyId)
      .single();
    if (docErr || !doc) return jsonResponse({ error: "Documento non trovato" }, 404);

    // 3. Download file from storage
    const { data: fileData, error: dlErr } = await svc
      .storage
      .from("kb-documents")
      .download(doc.storage_path);
    if (dlErr || !fileData) {
      await svc.from("kb_documents").update({
        status: "error",
        error_message: `Download fallito: ${dlErr?.message || "file non trovato"}`,
      }).eq("id", documentId);
      return jsonResponse({ error: "Download file fallito" }, 500);
    }

    const fileBytes = new Uint8Array(await fileData.arrayBuffer());

    // 4. Extract text
    let fullText: string;
    try {
      if (doc.file_type === "pdf") {
        fullText = await extractTextFromPdf(geminiKey, fileBytes);
      } else {
        fullText = extractTextFromPlain(fileBytes);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await svc.from("kb_documents").update({
        status: "error",
        error_message: `Estrazione testo fallita: ${msg.slice(0, 500)}`,
      }).eq("id", documentId);
      return jsonResponse({ error: `Estrazione fallita: ${msg}` }, 500);
    }

    if (!fullText || fullText.length < 10) {
      await svc.from("kb_documents").update({
        status: "error",
        error_message: "Documento vuoto o troppo corto",
      }).eq("id", documentId);
      return jsonResponse({ error: "Documento vuoto" }, 400);
    }

    // 5. Chunk the text
    const chunks = chunkText(fullText);
    if (chunks.length === 0) {
      await svc.from("kb_documents").update({
        status: "error",
        error_message: "Nessun chunk generato dal testo",
      }).eq("id", documentId);
      return jsonResponse({ error: "Nessun chunk" }, 400);
    }

    // 6. Generate embeddings for all chunks
    let embeddings: number[][];
    try {
      embeddings = await embedChunks(geminiKey, chunks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await svc.from("kb_documents").update({
        status: "error",
        error_message: `Embedding fallito: ${msg.slice(0, 500)}`,
      }).eq("id", documentId);
      return jsonResponse({ error: `Embedding fallito: ${msg}` }, 500);
    }

    // 7. Insert chunks with embeddings
    const chunkRows = chunks.map((content, i) => ({
      document_id: documentId,
      company_id: companyId,
      chunk_index: i,
      content,
      token_count: Math.ceil(content.split(/\s+/).length * 1.3), // rough estimate
      embedding: toVectorLiteral(embeddings[i]),
    }));

    // Insert in batches of 50 to avoid payload limits
    for (let i = 0; i < chunkRows.length; i += 50) {
      const batch = chunkRows.slice(i, i + 50);
      const { error: insertErr } = await svc
        .from("kb_chunks")
        .insert(batch);
      if (insertErr) {
        await svc.from("kb_documents").update({
          status: "error",
          error_message: `Inserimento chunks fallito: ${insertErr.message.slice(0, 500)}`,
        }).eq("id", documentId);
        return jsonResponse({ error: `Insert error: ${insertErr.message}` }, 500);
      }
    }

    // 8. Update document status → ready
    await svc.from("kb_documents").update({
      status: "ready",
      chunk_count: chunks.length,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", documentId);

    return jsonResponse({
      status: "ready",
      document_id: documentId,
      chunks: chunks.length,
      text_length: fullText.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Try to mark document as error
    await svc.from("kb_documents").update({
      status: "error",
      error_message: `Errore imprevisto: ${msg.slice(0, 500)}`,
    }).eq("id", documentId).catch(() => {});

    return jsonResponse({ error: msg }, 500);
  }
});
