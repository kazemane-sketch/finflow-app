import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 3;
const MAX_BATCH = 100;
const API_TIMEOUT_MS = 10_000;

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

/* ─── AI fallback via Haiku ────────────────── */

async function inferAtecoWithAi(
  apiKey: string,
  cp: CpRow,
): Promise<EnrichResult | null> {
  const prompt = `Sei un esperto di classificazione ATECO italiana (ISTAT 2007).
Data questa controparte:
- Nome: ${clip(cp.name, 200)}
- P.IVA: ${cp.vat_number || "N/D"}
- Sede: ${clip(cp.address, 200) || "N/D"}
- Tipo: ${cp.legal_type || "N/D"}

Inferisci il codice ATECO più probabile per questa attività.

REGOLE:
- Il codice ATECO deve essere nel formato XX.XX.XX (6 cifre con punti)
- Se non riesci a determinarlo con sicurezza, usa il livello di dettaglio più generico (XX.XX o XX)
- Per PA, usa 84.xx.xx
- Per professionisti (avvocati, commercialisti, etc.), usa 69.xx.xx
- Per studi di ingegneria/architettura, usa 71.xx.xx
- Rispondi SOLO con JSON valido, senza markdown

Formato risposta:
{"ateco_code":"XX.XX.XX","ateco_description":"Descrizione attività ATECO","business_description":"Breve descrizione di cosa fa l'azienda","confidence":0.8}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = await response.json();
    let text = data?.content?.[0]?.type === "text" ? data.content[0].text : "";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const parsed = JSON.parse(text);
    const atecoCode = parsed?.ateco_code || null;
    if (!atecoCode) return null;

    return {
      ateco_code: atecoCode,
      ateco_description: clip(parsed?.ateco_description, 300) || null,
      business_sector: mapAtecoToSector(atecoCode),
      business_description: clip(parsed?.business_description, 500) || null,
    };
  } catch {
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

  const anthropicKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const cameraleKey = (Deno.env.get("OPENAPI_CAMERALE_KEY") ?? "").trim();

  if (!anthropicKey && !cameraleKey) return json({ error: "Nessuna API key configurata (ANTHROPIC_API_KEY o OPENAPI_CAMERALE_KEY)" }, 503);
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
        let source = "ai";

        // Try Camerale API first
        if (cameraleKey && cp.vat_number) {
          result = await lookupCamerale(cameraleKey, cp.vat_number);
          if (result) source = "camerale";
        }

        // Fallback to AI
        if (!result && anthropicKey) {
          result = await inferAtecoWithAi(anthropicKey, cp);
          source = "ai";
        }

        if (result && result.ateco_code) {
          await sql`
            UPDATE counterparties
            SET ateco_code = ${result.ateco_code},
                ateco_description = ${result.ateco_description},
                business_sector = ${result.business_sector},
                business_description = ${result.business_description},
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
            error: "Nessun risultato",
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
