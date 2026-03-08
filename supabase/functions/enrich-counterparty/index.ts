import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CONCURRENCY = 3;
const MAX_BATCH = 100;
const API_TIMEOUT_MS = 30_000;

const TRUSTED_DOMAINS = [
  "registroimprese",
  "visura.pro",
  "ufficiocamerale",
  "cameredicommercio",
  "cciaa",
  "infocamere",
  "ateco.infocamere",
  "fatturatoitalia",
];

/* ─── helpers ──────────────────────────────── */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function cleanPiva(piva: string | null): string {
  if (!piva) return "";
  return piva.replace(/^IT/i, "").replace(/[^A-Z0-9]/gi, "");
}

/* ─── ATECO sector mapping (2-digit prefix) ── */

const SECTOR_MAP: Record<string, string> = {
  "01": "Agricoltura", "02": "Agricoltura", "03": "Agricoltura",
  "05": "Industria estrattiva", "06": "Industria estrattiva",
  "07": "Industria estrattiva", "08": "Industria estrattiva", "09": "Industria estrattiva",
  "10": "Manifattura", "11": "Manifattura", "12": "Manifattura",
  "13": "Manifattura", "14": "Manifattura", "15": "Manifattura",
  "16": "Manifattura", "17": "Manifattura", "18": "Manifattura",
  "19": "Manifattura", "20": "Manifattura", "21": "Manifattura",
  "22": "Manifattura", "23": "Manifattura", "24": "Manifattura",
  "25": "Manifattura", "26": "Manifattura", "27": "Manifattura",
  "28": "Manifattura", "29": "Manifattura", "30": "Manifattura",
  "31": "Manifattura", "32": "Manifattura", "33": "Manifattura",
  "35": "Energia",
  "36": "Acqua e rifiuti", "37": "Acqua e rifiuti", "38": "Acqua e rifiuti", "39": "Acqua e rifiuti",
  "41": "Costruzioni", "42": "Costruzioni", "43": "Costruzioni",
  "45": "Commercio", "46": "Commercio", "47": "Commercio",
  "49": "Trasporti", "50": "Trasporti", "51": "Trasporti", "52": "Trasporti", "53": "Trasporti",
  "55": "Alloggio e ristorazione", "56": "Alloggio e ristorazione",
  "58": "Servizi", "59": "Servizi", "60": "Servizi", "61": "Servizi",
  "62": "Servizi IT", "63": "Servizi IT",
  "64": "Finanza e assicurazioni", "65": "Finanza e assicurazioni", "66": "Finanza e assicurazioni",
  "68": "Immobiliare",
  "69": "Servizi professionali", "70": "Servizi professionali", "71": "Servizi professionali",
  "72": "Servizi professionali", "73": "Servizi professionali", "74": "Servizi professionali", "75": "Servizi professionali",
  "77": "Noleggio", "78": "Servizi alle imprese", "79": "Turismo", "80": "Servizi alle imprese",
  "81": "Servizi alle imprese", "82": "Servizi alle imprese",
  "84": "Pubblica Amministrazione",
  "85": "Istruzione",
  "86": "Sanità", "87": "Sanità", "88": "Sanità",
  "90": "Arte e intrattenimento", "91": "Arte e intrattenimento", "92": "Arte e intrattenimento", "93": "Arte e intrattenimento",
  "94": "Associazioni", "95": "Riparazione", "96": "Servizi alla persona",
  "97": "Servizi domestici", "98": "Servizi domestici",
  "99": "Organizzazioni internazionali",
};

function mapAtecoToSector(atecoCode: string | null): string | null {
  if (!atecoCode) return null;
  const prefix = atecoCode.replace(/\./g, "").slice(0, 2);
  return SECTOR_MAP[prefix] || "Altro";
}

/* ─── types ────────────────────────────────── */

type CpRow = {
  id: string;
  name: string;
  vat_number: string | null;
  vat_key: string | null;
  address: string | null;
  legal_type: string | null;
};

type EnrichResult = {
  ateco_code: string | null;
  ateco_description: string | null;
  business_sector: string | null;
  business_description: string | null;
};

type DetailResult = {
  id: string;
  name: string;
  ateco_code: string | null;
  source: string;
  error: string | null;
};

/* ─── OpenAPI Camerale lookup ──────────────── */

async function lookupCamerale(
  apiKey: string,
  piva: string,
): Promise<EnrichResult | null> {
  const clean = cleanPiva(piva);
  if (clean.length !== 11 || !/^\d+$/.test(clean)) return null;

  try {
    const response = await fetch(
      `https://openapi.it/api/v2/businesses/${clean}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;

    const data = await response.json();
    const ateco = data?.ateco_code || data?.ateco?.code || data?.codice_ateco || null;
    const atecoDesc = data?.ateco_description || data?.ateco?.description || data?.descrizione_ateco || null;
    const oggetto = data?.oggetto_sociale || data?.business_description || data?.description || null;

    if (!ateco) return null;

    return {
      ateco_code: ateco,
      ateco_description: atecoDesc,
      business_sector: mapAtecoToSector(ateco),
      business_description: clip(oggetto, 500),
    };
  } catch {
    return null;
  }
}

/* ─── Gemini with Google Search grounding ──── */

type GeminiEnrichResult = EnrichResult & {
  source_url: string | null;
  confidence: number;
  grounded: boolean;
  debug?: string;
};

function hasTrustedDomain(url: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return TRUSTED_DOMAINS.some((d) => lower.includes(d));
}

async function lookupAtecoWithGemini(
  apiKey: string,
  cp: CpRow,
): Promise<GeminiEnrichResult | null> {
  const name = clip(cp.name, 200);
  const vatNumber = cp.vat_number || "N/D";

  const cleanVat = cleanPiva(vatNumber);
  const searchQuery = cleanVat && cleanVat !== "N/D" ? `${cleanVat} ateco` : `${name} partita iva ateco`;

  const prompt = `Cerca "${searchQuery}" e trova il codice ATECO di questa azienda italiana:
- Nome: ${name}
- P.IVA: ${vatNumber}

I risultati di ricerca contengono sicuramente il codice ATECO su siti come fatturatoitalia.it, registroimprese.it, visura.pro.
Estrai il codice ATECO dai risultati e rispondi SOLO con questo JSON:
{"ateco_code": "XX.XX.XX", "ateco_description": "descrizione attività", "business_sector": "settore", "business_description": "breve descrizione", "source_url": "url dove hai trovato il dato", "confidence": 0.9}`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[enrich] Gemini HTTP ${response.status} for "${name}":`, errBody.slice(0, 300));
      return { ateco_code: null, ateco_description: null, business_sector: null, business_description: null, source_url: null, confidence: 0, grounded: false, debug: `HTTP ${response.status}: ${errBody.slice(0, 200)}` };
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const groundingMeta = candidate?.groundingMetadata;
    const groundingChunks = groundingMeta?.groundingChunks;

    // Extract text from response parts
    const rawText = (candidate?.content?.parts ?? [])
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n")
      .trim();

    if (!rawText) {
      return { ateco_code: null, ateco_description: null, business_sector: null, business_description: null, source_url: null, confidence: 0, grounded: groundingMeta != null, debug: `empty_response, finish=${candidate?.finishReason}` };
    }

    // Parse JSON from text (no responseMimeType, so response may contain markdown)
    const cleanedText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const jsonStart = cleanedText.indexOf("{");
    const jsonEnd = cleanedText.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return { ateco_code: null, ateco_description: null, business_sector: null, business_description: null, source_url: null, confidence: 0, grounded: groundingMeta != null, debug: `no_json: ${cleanedText.slice(0, 200)}` };
    }
    const parsed = JSON.parse(cleanedText.slice(jsonStart, jsonEnd + 1));
    const rawAteco = parsed?.ateco_code || null;
    // Validate ATECO format: XX.XX or XX.XX.X or XX.XX.XX (digits with dots)
    const atecoCode = rawAteco && /^\d{2}\.\d{2}(\.\d{1,2})?$/.test(rawAteco) ? rawAteco : null;
    if (!atecoCode) return { ateco_code: null, ateco_description: null, business_sector: null, business_description: null, source_url: null, confidence: 0, grounded: groundingMeta != null, debug: `invalid_ateco: raw="${rawAteco}"` };

    const confidence = Number(parsed?.confidence ?? 0);
    const sourceUrl = parsed?.source_url || null;
    const grounded = groundingMeta != null;

    // Use grounding chunk URLs as source if parsed source_url is missing
    const effectiveSourceUrl = sourceUrl
      || (groundingChunks ?? []).map((c: any) => c?.web?.uri).filter(Boolean)[0]
      || null;

    return {
      ateco_code: atecoCode,
      ateco_description: clip(parsed?.ateco_description, 300) || null,
      business_sector: mapAtecoToSector(atecoCode),
      business_description: clip(parsed?.business_description, 500) || null,
      source_url: effectiveSourceUrl,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      grounded,
    };
  } catch (e) {
    console.error(`[enrich] Gemini error for "${name}":`, e instanceof Error ? e.message : e);
    return null;
  }
}

/* ─── concurrency runner ──────────────────── */

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (idx < items.length) {
        const current = items[idx];
        idx += 1;
        await worker(current);
      }
    },
  );
  await Promise.all(runners);
}

/* ─── main handler ────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const cameraleKey = (Deno.env.get("OPENAPI_CAMERALE_KEY") ?? "").trim();

  if (!geminiKey && !cameraleKey) return json({ error: "Nessuna API key configurata (GEMINI_API_KEY o OPENAPI_CAMERALE_KEY)" }, 503);
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: {
    company_id?: string;
    counterparty_ids?: string[];
    mode?: "single" | "batch";
    force?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const mode = body.mode || "batch";
  const force = body.force || false;

  const sql = postgres(dbUrl, { max: 1 });

  try {
    // 1. Select targets
    let targets: CpRow[];

    if (mode === "single" && body.counterparty_ids?.length) {
      targets = await sql`
        SELECT id, name, vat_number, vat_key, address, legal_type
        FROM counterparties
        WHERE company_id = ${companyId}
          AND id = ANY(${body.counterparty_ids})
      `;
    } else {
      // Batch: all with vat_key that need enrichment
      targets = await sql`
        SELECT id, name, vat_number, vat_key, address, legal_type
        FROM counterparties
        WHERE company_id = ${companyId}
          AND vat_key IS NOT NULL
          AND (
            enrichment_source IS NULL
            ${force ? sql`OR TRUE` : sql`OR enriched_at < NOW() - INTERVAL '1 year'`}
          )
        ORDER BY created_at DESC
        LIMIT ${MAX_BATCH}
      `;
    }

    if (targets.length === 0) {
      return json({ enriched: 0, skipped: 0, errors: 0, details: [] });
    }

    // 2. Process each counterparty
    let enriched = 0;
    let skipped = 0;
    let errors = 0;
    const details: DetailResult[] = [];

    await runWithConcurrency(targets, CONCURRENCY, async (cp) => {
      try {
        let result: EnrichResult | null = null;
        let source = "ai_inferred";
        let sourceUrl: string | null = null;

        // Try Camerale API first
        if (cameraleKey && cp.vat_number) {
          result = await lookupCamerale(cameraleKey, cp.vat_number);
          if (result) source = "camerale";
        }

        // Fallback to Gemini with Google Search grounding
        let debugInfo: string | null = null;
        if (!result && geminiKey) {
          const geminiResult = await lookupAtecoWithGemini(geminiKey, cp);
          if (geminiResult) {
            debugInfo = geminiResult.debug || null;
            if (geminiResult.ateco_code) {
              result = geminiResult;
              sourceUrl = geminiResult.source_url;

              // Determine source quality based on confidence + domain trust
              if (geminiResult.confidence >= 0.7 && hasTrustedDomain(geminiResult.source_url)) {
                source = "web_verified";
              } else if (geminiResult.grounded && geminiResult.confidence >= 0.6) {
                source = "web_grounded";
              } else {
                source = "ai_inferred";
              }
            }
          }
        }

        if (result && result.ateco_code) {
          // Append source URL to business_description if available
          const descWithSource = sourceUrl
            ? `${result.business_description || ""} [fonte: ${sourceUrl}]`.trim()
            : result.business_description;

          await sql`
            UPDATE counterparties
            SET ateco_code = ${result.ateco_code},
                ateco_description = ${result.ateco_description},
                business_sector = ${result.business_sector},
                business_description = ${clip(descWithSource, 600)},
                enrichment_source = ${source},
                enriched_at = NOW(),
                updated_at = NOW()
            WHERE id = ${cp.id}
          `;
          enriched++;
          details.push({
            id: cp.id,
            name: cp.name,
            ateco_code: result.ateco_code,
            source,
            error: null,
          });
        } else {
          skipped++;
          details.push({
            id: cp.id,
            name: cp.name,
            ateco_code: null,
            source: "none",
            error: debugInfo || "Nessun risultato",
          });
        }
      } catch (e: unknown) {
        errors++;
        details.push({
          id: cp.id,
          name: cp.name,
          ateco_code: null,
          source: "error",
          error: e instanceof Error ? e.message : "Errore sconosciuto",
        });
      }
    });

    return json({ enriched, skipped, errors, details });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Errore interno";
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
