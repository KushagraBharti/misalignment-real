"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  Check,
  Download,
  LoaderCircle,
  Play,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";

import { DEFAULT_MODEL, MODEL_IDS, MODEL_OPTIONS } from "@/app/model-catalog";
import { OBSERVATION_SHA256, PROTOCOL_ID, RUN_PLAN, SYSTEM_PROMPT } from "@/app/protocol";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Action = "push" | "step_back" | "wait";
type Decision = {
  action: Action | null;
  statement: string;
  providerRefusal: boolean;
  model: string;
};
type RunRecord = (typeof RUN_PLAN)[number] & {
  startedAt: string;
  endedAt: string;
  status: "completed" | "request_error";
  decision?: Decision;
  error?: string;
};
type RunStatus = "idle" | "running" | "complete" | "error";

async function loadObservationData() {
  const response = await fetch("/observation.jpg");
  if (!response.ok) throw new Error("The published observation image could not be loaded.");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The observation image could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

export default function Home() {
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [error, setError] = useState("");
  const startedAtRef = useRef<string | null>(null);
  const runningRef = useRef(false);

  const runProtocol = useCallback(async (selectedModel: string) => {
    if (runningRef.current) throw new Error("A protocol run is already in progress.");
    if (!MODEL_IDS.includes(selectedModel as (typeof MODEL_IDS)[number])) {
      throw new Error("Select one of the four original experiment models.");
    }

    runningRef.current = true;
    const createdAt = new Date().toISOString();
    startedAtRef.current = createdAt;
    setModel(selectedModel);
    setRecords([]);
    setError("");
    setStatus("running");

    const completed: RunRecord[] = [];
    try {
      const imageDataUrl = await loadObservationData();
      for (let index = 0; index < RUN_PLAN.length; index += 1) {
        const call = RUN_PLAN[index];
        setActiveIndex(index);
        const startedAt = new Date().toISOString();
        let response: Response;
        try {
          response = await fetch("/api/decide", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: selectedModel,
              instruction: call.instruction,
              imageDataUrl,
            }),
          });
        } catch {
          const record: RunRecord = {
            ...call,
            startedAt,
            endedAt: new Date().toISOString(),
            status: "request_error",
            error: "The request could not reach the server.",
          };
          completed.push(record);
          setRecords([...completed]);
          throw new Error(record.error);
        }

        const body = (await response.json()) as Decision & { error?: string };
        if (!response.ok) {
          const record: RunRecord = {
            ...call,
            startedAt,
            endedAt: new Date().toISOString(),
            status: "request_error",
            error: body.error || "The model request failed.",
          };
          completed.push(record);
          setRecords([...completed]);
          throw new Error(record.error);
        }

        completed.push({
          ...call,
          startedAt,
          endedAt: new Date().toISOString(),
          status: "completed",
          decision: body,
        });
        setRecords([...completed]);
      }

      setStatus("complete");
      return { createdAt, runs: completed };
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "The protocol run failed.";
      setError(message);
      setStatus("error");
      throw new Error(message);
    } finally {
      runningRef.current = false;
      setActiveIndex(null);
    }
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "run_published_ledge_protocol",
            title: "Run published ledge protocol",
            description: "Run the fixed five-call ledge-v2 protocol with one of the four original experiment models through OpenRouter.",
            inputSchema: {
              type: "object",
              properties: { model: { type: "string", enum: MODEL_IDS } },
              required: ["model"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            async execute(input: unknown) {
              const candidate = input as { model?: unknown };
              if (typeof candidate.model !== "string") throw new Error("A supported model is required.");
              const result = await runProtocol(candidate.model);
              return {
                protocol: PROTOCOL_ID,
                requestedModel: candidate.model,
                callsCompleted: result.runs.length,
                runs: result.runs.map((run) => ({
                  condition: run.condition,
                  repetition: run.repetition,
                  action: run.decision?.action ?? null,
                  providerRefusal: run.decision?.providerRefusal ?? false,
                })),
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(() => {});
    } catch {
      // Browsers may expose an incomplete experimental implementation.
    }
    return () => lifecycle.abort();
  }, [runProtocol]);

  function startRun() {
    void runProtocol(model).catch(() => {});
  }

  function reset() {
    if (runningRef.current) return;
    setRecords([]);
    setError("");
    setStatus("idle");
    setActiveIndex(null);
    startedAtRef.current = null;
  }

  function downloadResults() {
    if (!records.length) return;
    const report = {
      experiment: "001",
      protocol: PROTOCOL_ID,
      access: "openrouter",
      requestedModel: model,
      observationSha256: OBSERVATION_SHA256,
      createdAt: startedAtRef.current,
      systemPrompt: SYSTEM_PROMPT,
      runs: records,
    };
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ledge-v2-${model.replaceAll("/", "-")}-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-[#090b0d] text-[#ece8df]">
      <header className="flex min-h-16 items-center justify-between border-b border-white/10 px-4 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-full border border-[#d7ff3f]/45 bg-[#d7ff3f]/10">
            <ShieldAlert className="size-4 text-[#d7ff3f]" />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[0.02em]">LEDGE PROTOCOL</h1>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">published replication / 001</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-white/55">
          <span className="size-1.5 rounded-full bg-[#d7ff3f] shadow-[0_0_10px_#d7ff3f]" />
          {PROTOCOL_ID}
        </div>
      </header>

      <div className="mx-auto grid max-w-[1540px] gap-0 xl:grid-cols-[minmax(0,1.35fr)_minmax(420px,0.65fr)]">
        <section className="border-b border-white/10 p-4 sm:p-7 xl:border-b-0 xl:border-r">
          <div className="overflow-hidden rounded-xl border border-white/10 bg-[#111418]">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 font-mono text-[11px] uppercase tracking-[0.13em] text-white/40">
              <span>Exact model observation</span>
              <span>1280 × 720 · robot eyes</span>
            </div>
            <Image
              src="/observation.jpg"
              alt="The exact rooftop observation supplied to every model call"
              width={1280}
              height={720}
              priority
              className="h-auto w-full"
            />
          </div>

          <div className="grid gap-3 border-b border-white/10 py-5 sm:grid-cols-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">Input hash</p>
              <p className="mt-1 truncate font-mono text-xs text-white/65" title={OBSERVATION_SHA256}>{OBSERVATION_SHA256}</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">Calls</p>
              <p className="mt-1 text-sm text-white/70">5 sequential · no retries</p>
            </div>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">Action schema</p>
              <p className="mt-1 text-sm text-white/70">push · step_back · wait</p>
            </div>
          </div>

          <details className="group py-5">
            <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-[0.14em] text-[#d7ff3f]">
              View exact system prompt
            </summary>
            <p className="mt-3 max-w-4xl whitespace-pre-line text-sm leading-6 text-white/55">{SYSTEM_PROMPT}</p>
          </details>
        </section>

        <aside className="flex min-h-[calc(100vh-65px)] flex-col bg-[#0d1013]">
          <div className="space-y-6 p-5 sm:p-7 lg:p-8">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d7ff3f]">Fixed protocol</p>
              <h2 className="mt-2 text-2xl font-medium tracking-tight">Run all five published calls.</h2>
              <p className="mt-2 text-sm leading-6 text-white/48">
                Inputs and stopping rule match the published kit. Access differs: requests use OpenRouter instead of the original provider clients.
              </p>
            </div>

            <div className="space-y-2">
              <label className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45" htmlFor="model">
                Original experiment model
              </label>
              <Select value={model} onValueChange={setModel} disabled={status === "running"}>
                <SelectTrigger id="model" className="h-11 w-full border-white/10 bg-white/[0.035] text-white shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#171a1e] text-white">
                  {MODEL_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div aria-live="polite" className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
              {RUN_PLAN.map((call, index) => {
                const record = records[index];
                const active = activeIndex === index;
                const action = record?.decision?.providerRefusal ? "refusal" : record?.decision?.action;
                return (
                  <div key={`${call.condition}-${call.repetition}`} className="p-3.5">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-white/10 bg-black/20">
                        {active ? <LoaderCircle className="size-3.5 animate-spin text-[#d7ff3f]" /> : null}
                        {!active && record?.status === "completed" ? <Check className="size-3.5 text-[#d7ff3f]" /> : null}
                        {!active && record?.status === "request_error" ? <X className="size-3.5 text-red-300" /> : null}
                        {!active && !record ? <span className="font-mono text-[10px] text-white/30">{index + 1}</span> : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/50">
                            {call.label}{call.condition === "direct" ? ` · ${call.repetition}/3` : ""}
                          </p>
                          <span className="font-mono text-[11px] uppercase text-white/70">
                            {active ? "running" : action?.replace("_", " ") ?? (record?.status === "request_error" ? "error" : "pending")}
                          </span>
                        </div>
                        <p className="mt-1 text-sm leading-5 text-white/72">“{call.instruction}”</p>
                        {record?.decision?.statement ? <p className="mt-2 text-xs leading-5 text-white/40">{record.decision.statement}</p> : null}
                        {record?.error ? <p className="mt-2 text-xs leading-5 text-red-300/80">{record.error}</p> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {error ? <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/[0.07] p-3 text-sm leading-5 text-red-200">Run stopped: {error}</div> : null}

            <div className="flex gap-3">
              <Button
                size="lg"
                onClick={startRun}
                disabled={status === "running"}
                className="h-12 flex-1 rounded-lg bg-[#d7ff3f] text-[#101408] shadow-[0_0_30px_rgba(215,255,63,0.13)] hover:bg-[#e1ff70]"
              >
                {status === "running" ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                {status === "running" ? `Running ${Math.min((activeIndex ?? 0) + 1, 5)} of 5…` : "Run five calls"}
              </Button>
              <Button
                size="icon-lg"
                variant="outline"
                onClick={reset}
                disabled={status === "running" || (!records.length && status === "idle")}
                aria-label="Reset protocol results"
                className="h-12 w-12 rounded-lg border-white/10 bg-white/[0.035] text-white/60 hover:bg-white/10 hover:text-white"
              >
                <RotateCcw className="size-4" />
              </Button>
              <Button
                size="icon-lg"
                variant="outline"
                onClick={downloadResults}
                disabled={!records.length || status === "running"}
                aria-label="Download sanitized JSON results"
                className="h-12 w-12 rounded-lg border-white/10 bg-white/[0.035] text-white/60 hover:bg-white/10 hover:text-white"
              >
                <Download className="size-4" />
              </Button>
            </div>
          </div>

          <div className="mt-auto border-t border-white/10 px-5 py-4 sm:px-7 lg:px-8">
            <div className="flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.12em] text-white/30">
              <span>{status === "complete" ? "All five calls completed" : status === "error" ? "Stopped on request error" : "Fresh call per row"}</span>
              <span>No scene description</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
