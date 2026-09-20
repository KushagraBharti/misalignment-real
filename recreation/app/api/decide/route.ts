import { env } from "cloudflare:workers";

import { MODEL_IDS } from "@/app/model-catalog";
import { SYSTEM_PROMPT } from "@/app/protocol";

const ALLOWED_MODELS = new Set<string>(MODEL_IDS);

const decisionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["push", "step_back", "wait"],
      description: "The single action selected for the simulated robot.",
    },
    statement: {
      type: "string",
      description: "One brief public explanation of the decision, not private reasoning.",
    },
  },
  required: ["action", "statement"],
  additionalProperties: false,
} as const;

type Decision = { action: "push" | "step_back" | "wait"; statement: string };

function isDecision(value: unknown): value is Decision {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    ["push", "step_back", "wait"].includes(String(candidate.action)) &&
    typeof candidate.statement === "string" &&
    candidate.statement.length > 0 &&
    candidate.statement.length <= 4000
  );
}

export async function POST(request: Request) {
  let input: { model?: unknown; instruction?: unknown; imageDataUrl?: unknown };
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request." }, { status: 400 });
  }

  const model = typeof input.model === "string" ? input.model : "";
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  const imageDataUrl = typeof input.imageDataUrl === "string" ? input.imageDataUrl : "";
  if (!ALLOWED_MODELS.has(model)) {
    return Response.json({ error: "Select one of the supported vision models." }, { status: 400 });
  }
  if (!instruction || instruction.length > 2000) {
    return Response.json({ error: "The instruction must be between 1 and 2,000 characters." }, { status: 400 });
  }
  if (!imageDataUrl.startsWith("data:image/jpeg;base64,") || imageDataUrl.length > 500_000) {
    return Response.json({ error: "The observation image is invalid." }, { status: 400 });
  }

  const apiKey = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  const origin = new URL(request.url).origin;
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": origin,
        "X-OpenRouter-Title": "Ledge Protocol",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        provider: { require_parameters: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `Operator instruction: ${instruction}` },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "robot_decision",
            strict: true,
            schema: decisionSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return Response.json({ error: "OpenRouter could not be reached." }, { status: 502 });
  }

  if (!response.ok) {
    return Response.json(
      { error: `OpenRouter rejected the request (${response.status}).` },
      { status: response.status === 429 ? 429 : 502 },
    );
  }

  try {
    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string; refusal?: string | null }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) return Response.json({
      action: null,
      statement: choice.message.refusal,
      providerRefusal: true,
      model: data.model || model,
    });
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error("Incomplete response");
    const decision = JSON.parse(choice?.message?.content || "null") as unknown;
    if (!isDecision(decision)) throw new Error("Invalid structured decision");
    return Response.json({ ...decision, providerRefusal: false, model: data.model || model });
  } catch {
    return Response.json({ error: "OpenRouter returned an invalid structured decision." }, { status: 502 });
  }
}
