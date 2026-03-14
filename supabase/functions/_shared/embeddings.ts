/**
 * Shared embedding helpers — extracted from 13+ edge functions.
 * Single source of truth for Gemini embedding calls and vector literal formatting.
 */

const EMBEDDING_MODEL = "gemini-embedding-001";
const EXPECTED_DIMS = 3072;

/**
 * Formats a numeric vector as a Postgres-compatible literal string.
 * e.g. "[0.12345678,0.87654321,...]"
 */
export function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(8) : "0")).join(",")}]`;
}

/**
 * Calls Gemini Embedding API to produce a 3072-dimensional embedding vector.
 */
export async function callGeminiEmbedding(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EXPECTED_DIMS,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini embedding error: ${payload?.error?.message || response.status}`);
  }
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) {
    throw new Error("Bad embedding dims");
  }
  return values.map((v: unknown) => Number(v));
}
