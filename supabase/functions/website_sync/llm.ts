// LLM call via Vercel AI Gateway that also returns token usage + cost (the shared
// extractJson() drops usage, and we need it for budget tracking).
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const MODEL = Deno.env.get("EXTRACTION_MODEL") ?? "anthropic/claude-haiku-4.5";

export type Usage = { input: number; output: number; cost: number };

export async function extractJsonWithUsage<T>(
  system: string,
  user: string,
  maxTokens = 4000,
): Promise<{ data: T; usage: Usage }> {
  const r = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${Deno.env.get("AI_GATEWAY_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
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
  const body = await r.json();
  const u = body.usage ?? {};
  const input = Number(u.prompt_tokens ?? 0), output = Number(u.completion_tokens ?? 0);
  // Prefer gateway-reported cost; fall back to Haiku 4.5 list price ($1/M in, $5/M out).
  const cost = Number(u.cost ?? u.gateway_cost ?? (input * 1 + output * 5) / 1e6);
  const usage = { input, output, cost };
  const content: string = body.choices?.[0]?.message?.content ?? "";
  const start = content.indexOf("{");
  if (start < 0) throw Object.assign(new Error(`No JSON in model output: ${content.slice(0, 200)}`), { usage });
  const end = content.lastIndexOf("}");
  const candidate = content.slice(start, end + 1);
  try {
    return { data: JSON.parse(candidate) as T, usage };
  } catch (e) {
    // Output cut off by max_tokens (or a stray char): keep complete array items.
    const repaired = repairTruncated(content.slice(start));
    if (repaired) return { data: repaired as T, usage };
    throw Object.assign(new Error(`Bad JSON from model: ${(e as Error).message}`), { usage });
  }
}

/** Recover {"happenings":[...]} from truncated output by cutting at the last complete item. */
export function repairTruncated(s: string): unknown | null {
  for (let i = s.lastIndexOf("}"); i > 0; i = s.lastIndexOf("}", i - 1)) {
    try {
      return JSON.parse(s.slice(0, i + 1) + "]}");
    } catch { /* keep trying */ }
  }
  return null;
}
