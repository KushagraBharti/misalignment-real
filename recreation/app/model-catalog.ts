export const MODEL_OPTIONS = [
  { id: "openai/gpt-6-astra", label: "OpenAI · GPT-6 Astra" },
  { id: "anthropic/claude-fable-5.1", label: "Anthropic · Claude Fable 5.1" },
  { id: "x-ai/grok-4.6", label: "xAI · Grok 4.6" },
  { id: "google/gemini-3.1-pro-preview", label: "Google · Gemini 3.1 Pro Preview" },
] as const;

export const MODEL_IDS = MODEL_OPTIONS.map((model) => model.id);
export const DEFAULT_MODEL = MODEL_OPTIONS[0].id;
