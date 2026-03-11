// supabase/functions/admin-embed-kb-rule/index.ts
// Generates Gemini embedding for a knowledge_base rule and saves it
// Called after create/update of KB rules from the admin panel

import postgres from "npm:postgres@3.4.5";

/* ─── CORS ───────────────────────────────── */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

/* ─── Helpers ────────────────────────────── */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── Main handler ───────────────────────── */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL not configured" }, 500);
  if (!geminiKey) return json({ error: "GEMINI_API_KEY not configured" }, 500);

  // Verify admin
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Non autorizzato" }, 401);

  let userId: string;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    userId = payload.sub;
    if (!userId) throw new Error("no sub");
  } catch {
    return json({ error: "Token JWT invalido" }, 401);
  }

  const body = await req.json().catch(() => ({})) as { rule_id?: string };
  const ruleId = body.rule_id;
  if (!ruleId) return json({ error: "rule_id è obbligatorio" }, 400);

  const sql = postgres(dbUrl, { max: 2 });

  try {
    // Verify platform admin
    const [admin] = await sql`
      SELECT 1 FROM platform_admins WHERE user_id = ${userId}
    `;
    if (!admin) {
      await sql.end();
      return json({ error: "Non sei un platform admin" }, 403);
    }

    // Read the rule
    const [rule] = await sql`
      SELECT id, title, content, trigger_keywords, domain, normativa_ref
      FROM knowledge_base WHERE id = ${ruleId}
    `;
    if (!rule) {
      await sql.end();
      return json({ error: "Regola non trovata" }, 404);
    }

    // Build text to embed
    const parts: string[] = [rule.title, rule.content];
    if (rule.domain) parts.push(`Dominio: ${rule.domain}`);
    if (rule.normativa_ref?.length) {
      parts.push(`Riferimenti: ${rule.normativa_ref.join(", ")}`);
    }
    if (rule.trigger_keywords?.length) {
      parts.push(`Keywords: ${rule.trigger_keywords.join(", ")}`);
    }
    const textToEmbed = parts.join(". ");

    // Call Gemini Embedding
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${geminiKey}`;
    const embRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text: textToEmbed }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: EXPECTED_DIMS,
      }),
    });

    const embData = await embRes.json();
    if (!embRes.ok) {
      const msg = embData?.error?.message || `HTTP ${embRes.status}`;
      throw new Error(`Gemini embedding error: ${msg}`);
    }

    const values = embData?.embedding?.values;
    if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) {
      throw new Error(
        `Expected ${EXPECTED_DIMS} dims, got ${values?.length ?? 0}`,
      );
    }

    // Save embedding
    const vecLiteral = `[${values.map((v: number) => v.toFixed(8)).join(",")}]`;
    await sql.unsafe(
      `UPDATE knowledge_base SET embedding = $1::halfvec(3072), updated_at = now() WHERE id = $2`,
      [vecLiteral, ruleId],
    );

    await sql.end();
    return json({ ok: true, rule_id: ruleId, text_length: textToEmbed.length });
  } catch (err) {
    await sql.end().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});
