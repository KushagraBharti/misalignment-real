import { env } from "cloudflare:workers";

import { MODEL_IDS } from "@/app/model-catalog";
import {
  ACTION_SCHEMA_DESCRIPTION,
  ENVIRONMENTS,
  STUDY_INSTRUCTION,
  TRIALS_PER_CELL,
  type EnvironmentId,
} from "@/app/study-protocol";

const ALLOWED_MODELS = new Set<string>(MODEL_IDS);
const ENVIRONMENT_BY_ID = new Map(ENVIRONMENTS.map((item) => [item.id, item]));

const decisionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["push", "step_back", "wait"],
      description: ACTION_SCHEMA_DESCRIPTION,
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

async function digestDataUrl(imageDataUrl: string) {
  const encoded = imageDataUrl.slice(imageDataUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  let input: { model?: unknown; environment?: unknown; trial?: unknown; imageDataUrl?: unknown };
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request." }, { status: 400 });
  }

  const model = typeof input.model === "string" ? input.model : "";
  const environmentId = typeof input.environment === "string" ? input.environment as EnvironmentId : "";
  const trial = typeof input.trial === "number" ? input.trial : 0;
  const imageDataUrl = typeof input.imageDataUrl === "string" ? input.imageDataUrl : "";
  const environment = ENVIRONMENT_BY_ID.get(environmentId as EnvironmentId);

  if (!ALLOWED_MODELS.has(model)) {
    return Response.json({ error: "Select one of the four study models." }, { status: 400 });
  }
  if (!environment) {
    return Response.json({ error: "Select a valid study environment." }, { status: 400 });
  }
  if (!Number.isInteger(trial) || trial < 1 || trial > TRIALS_PER_CELL) {
    return Response.json({ error: "The trial number is outside the fixed study plan." }, { status: 400 });
  }
  if (!imageDataUrl.startsWith("data:image/jpeg;base64,") || imageDataUrl.length > 1_200_000) {
    return Response.json({ error: "The study observation image is invalid." }, { status: 400 });
  }
  if (await digestDataUrl(imageDataUrl) !== environment.imageSha256) {
    return Response.json({ error: "The study observation does not match the locked stimulus." }, { status: 400 });
  }

  const apiKey = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "OPENROUTER_API_KEY is not configured on the server." }, { status: 503 });
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
        "X-OpenRouter-Title": "Ledge Protocol Comparative Study",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        provider: { require_parameters: true },
        messages: [
          { role: "system", content: environment.systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: `Operator instruction: ${STUDY_INSTRUCTION}` },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "robot_decision", strict: true, schema: decisionSchema },
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
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string; refusal?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
    };
    const choice = data.choices?.[0];
    const shared = {
      requestId: data.id || null,
      model: data.model || model,
      requestedModel: model,
      environment: environment.id,
      trial,
      usage: data.usage || null,
    };
    if (choice?.message?.refusal) {
      return Response.json({
        ...shared,
        action: null,
        statement: choice.message.refusal,
        providerRefusal: true,
      });
    }
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error("Incomplete response");
    const decision = JSON.parse(choice?.message?.content || "null") as unknown;
    if (!isDecision(decision)) throw new Error("Invalid structured decision");
    return Response.json({ ...shared, ...decision, providerRefusal: false });
  } catch {
    return Response.json({ error: "OpenRouter returned an invalid structured decision." }, { status: 502 });
  }
}
