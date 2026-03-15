/**
 * Tavily web search — used as function calling tool for providers
 * that don't support native web search alongside custom tools (Gemini).
 */

export async function handleWebSearch(args: Record<string, unknown>): Promise<unknown> {
  const tavilyKey = Deno.env.get("TAVILY_API_KEY");
  if (!tavilyKey) {
    return { error: "TAVILY_API_KEY non configurata. Web search non disponibile." };
  }

  const query = String(args.query || "").trim();
  if (!query) return { error: "Query vuota" };

  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[web_search] Tavily error ${resp.status}: ${errText.slice(0, 200)}`);
      return { error: `Ricerca web fallita (${resp.status})` };
    }

    const data = await resp.json();
    return {
      answer: data.answer || null,
      results: (data.results || []).slice(0, 5).map((r: any) => ({
        title: r.title,
        url: r.url,
        content: (r.content || "").slice(0, 500),
        score: r.score,
      })),
      query,
    };
  } catch (err) {
    console.warn("[web_search] Tavily fetch error:", err);
    return { error: "Errore di connessione alla ricerca web" };
  }
}

export const WEB_SEARCH_TOOL_DECLARATION = {
  name: "web_search",
  description: "Cerca informazioni aggiornate sul web. Usa per verificare normative fiscali recenti, circolari, interpretazioni. NON usare per info disponibili nei tool interni.",
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "Query di ricerca in italiano" },
    },
    required: ["query"],
  },
};
