// LLM extraction via Vercel AI Gateway (OpenAI-compatible endpoint) using a Haiku-class model.
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const EXTRACTION_MODEL = Deno.env.get("EXTRACTION_MODEL") ?? "anthropic/claude-haiku-4.5";

/** Ask the model for strict JSON. Returns parsed object (throws on invalid JSON). */
export async function extractJson<T>(system: string, user: string, maxTokens = 2000): Promise<T> {
  const r = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${Deno.env.get("AI_GATEWAY_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`AI gateway ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error(`No JSON in model output: ${content.slice(0, 200)}`);
  return JSON.parse(m[0]) as T;
}
