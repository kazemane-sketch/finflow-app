// supabase/functions/parse-bank-pdf-router/index.ts
// Router per import banca: sceglie engine legacy/ocr per company_id.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const payload = await req.json().catch(() => ({}));
    const companyId = typeof payload?.companyId === "string" ? payload.companyId : null;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY non configurata" }, 500);
    }

    let engine: "legacy" | "ocr" = "legacy";
    if (companyId) {
      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await admin
        .from("bank_import_engine_settings")
        .select("engine")
        .eq("company_id", companyId)
        .maybeSingle();

      if (error) {
        console.error("engine setting lookup error:", error.message);
      } else if (data?.engine === "ocr") {
        engine = "ocr";
      }
    }

    const targetFn = engine === "ocr" ? "parse-bank-pdf-ocr" : "parse-bank-pdf";
    console.log(`engine_selected=${engine} company_id=${companyId ?? "n/a"} target=${targetFn}`);

    const upstream = await fetch(`${supabaseUrl}/functions/v1/${targetFn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      return new Response(body || JSON.stringify({ error: `Errore upstream ${upstream.status}` }), {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          "Content-Type": upstream.headers.get("content-type") || "application/json",
        },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
        "Cache-Control": upstream.headers.get("cache-control") || "no-cache",
        "Connection": "keep-alive",
        "X-Bank-Engine": engine,
      },
    });
  } catch (e) {
    console.error("parse-bank-pdf-router error:", e);
    return json({ error: e instanceof Error ? e.message : "Errore sconosciuto" }, 500);
  }
});
