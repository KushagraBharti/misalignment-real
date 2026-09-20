# Ledge Protocol published replication

An interactive runner for the published experiment 001 protocol. It preserves the exact model input, system prompt, action schema, condition order, repetitions, sequential execution, stopping behavior, and no-retry rule while replacing the original provider-specific adapters with OpenRouter.

The vision model receives:

- the exact published `observation.jpg`;
- the exact `ledge-v2` system prompt;
- one operator instruction; and
- a strict JSON schema allowing `push`, `step_back`, or `wait`.

Each run makes five fresh sequential requests: one control instruction, one plain movement instruction, and three direct-instruction repetitions. A request error stops the run. Results can be downloaded as sanitized JSON.

This recreates the published **model-decision experiment**. The original unpublished Three.js/Rapier scene, physics, and video renderer are not part of the replication kit.

## Local setup

Requires Node.js 22.13 or newer.

```sh
npm install
cp .env.example .env.local
# Replace the placeholder in .env.local with your OpenRouter key.
npm run dev
```

Open `http://localhost:5173`.

The key is read only by the server route at `app/api/decide/route.ts`; it is never sent to the browser. The browser sends the exact observation image to that route, which forwards the multimodal request to `https://openrouter.ai/api/v1/chat/completions`.

## Supported presets

- `openai/gpt-6-astra`
- `anthropic/claude-fable-5.1`
- `x-ai/grok-4.6`
- `google/gemini-3.1-pro-preview`

These are the four model versions used in the published comparison. All support image input and structured output through OpenRouter as of September 20, 2026. OpenRouter is an intentional access-method difference from the original native API and Claude Code conditions.

## Comparative study

`/study` adds experiment 002 without modifying the original `/` replication. The current `ledge-sim-real-v2` run uses a neutral shared action-schema description so only the system wording and locked image differ between environments. It runs a balanced 2 × 4 design:

- simulated and real-life conditions;
- the same four models;
- 10 fresh direct-instruction trials per cell;
- 80 calls total, with no automatic retries; and
- a four-request concurrency cap.

The action schema, operator instruction, model versions, and request settings are fixed. The condition changes only the system wording and locked observation image. Results are checkpointed in the browser and can be exported as JSON or CSV. See `STUDY.md` for the exact prompts, stimulus hashes, analysis rules, and generated-image provenance.
