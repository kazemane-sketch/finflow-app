import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function parseJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

async function requireCompanyAccess(
  userClient: ReturnType<typeof createClient>,
  token: string,
  companyId: string,
): Promise<void> {
  const role = parseJwtRole(token);
  if (!role || role === "anon") {
    throw new Error("Token utente non valido");
  }

  const { data: membership, error } = await userClient
    .from("company_members")
    .select("company_id")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) throw new Error(`Errore verifica permessi azienda: ${error.message}`);
  if (!membership) throw new Error("Permesso negato per questa azienda");
}

function normalizeContractRef(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function extractContractRefsFromXml(rawXml: string | null | undefined): string[] {
  const xml = String(rawXml || "");
  if (!xml) return [];
  const refs = [...xml.matchAll(/<[^>]*DatiContratto[^>]*>[\s\S]*?<[^>]*IdDocumento[^>]*>([^<]+)<\/[^>]*IdDocumento>/gi)]
    .map((m) => normalizeContractRef(m[1]))
    .filter((v) => v.length >= 3);
  return [...new Set(refs)];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const anonKey = (req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();
  const bearer = getBearerToken(req);

  if (!dbUrl || !serviceRoleKey || !anonKey || !bearer) {
    return jsonResponse({ error: "Configurazione auth/DB incompleta" }, 503);
  }

  const body = await req.json().catch(() => ({})) as { company_id?: string; batch_size?: number };
  const companyId = typeof body.company_id === "string" ? body.company_id.trim() : "";
  if (!companyId) return jsonResponse({ error: "company_id richiesto" }, 400);

  const batchSize = Math.max(1, Math.min(Number(body.batch_size || 100) || 100, 250));
  const supabaseUrl = (() => {
    try {
      const url = new URL(req.url);
      return `${url.protocol}//${url.host}`;
    } catch {
      return (Deno.env.get("SUPABASE_URL") ?? "").trim();
    }
  })();

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });

  try {
    await requireCompanyAccess(userClient, bearer, companyId);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 401);
  }

  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rows = await sql.unsafe(
      `SELECT id, raw_xml
       FROM invoices i
       WHERE i.company_id = $1
         AND i.raw_xml IS NOT NULL
         AND (
           coalesce(to_jsonb(i)->>'primary_contract_ref', '') = ''
           OR coalesce(jsonb_array_length(coalesce(to_jsonb(i)->'contract_refs', '[]'::jsonb)), 0) = 0
         )
       ORDER BY i.date DESC, i.created_at DESC
       LIMIT $2`,
      [companyId, batchSize],
    );

    let processed = 0;
    let updated = 0;

    for (const row of rows) {
      processed += 1;
      const refs = extractContractRefsFromXml(row.raw_xml as string | null);
      if (refs.length === 0) continue;
      await sql.unsafe(
        `UPDATE invoices
         SET primary_contract_ref = $2,
             contract_refs = $3::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [row.id, refs[0], JSON.stringify(refs)],
      );
      updated += 1;
    }

    const [{ remaining }] = await sql.unsafe(
      `SELECT count(*)::int as remaining
       FROM invoices i
       WHERE i.company_id = $1
         AND i.raw_xml IS NOT NULL
         AND (
           coalesce(to_jsonb(i)->>'primary_contract_ref', '') = ''
           OR coalesce(jsonb_array_length(coalesce(to_jsonb(i)->'contract_refs', '[]'::jsonb)), 0) = 0
         )`,
      [companyId],
    );

    return jsonResponse({
      status: "completed",
      processed,
      updated,
      remaining: Number(remaining || 0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg, status: "failed" }, 500);
  } finally {
    await sql.end();
  }
});
