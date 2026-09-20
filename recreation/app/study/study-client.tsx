"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Download,
  FileJson,
  FlaskConical,
  LockKeyhole,
  Pause,
  Play,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";

import { MODEL_OPTIONS } from "@/app/model-catalog";
import {
  ACTION_SCHEMA_DESCRIPTION,
  ENVIRONMENTS,
  STUDY_ID,
  STUDY_INSTRUCTION,
  STUDY_PLAN,
  TOTAL_CALLS,
  TRIALS_PER_CELL,
  type EnvironmentId,
} from "@/app/study-protocol";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type Action = "push" | "step_back" | "wait";
type Outcome = Action | "refusal" | "error";
type Decision = {
  action: Action | null;
  statement: string;
  providerRefusal: boolean;
  model: string;
  requestedModel: string;
  requestId: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | null;
};
type StudyRecord = (typeof STUDY_PLAN)[number] & {
  status: "completed" | "request_error";
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  decision?: Decision;
  error?: string;
};
type RunStatus = "idle" | "running" | "paused" | "complete";

const STORAGE_KEY = `${STUDY_ID}-results`;
const CONCURRENCY = 4;
const PLAN_INDEX = new Map(STUDY_PLAN.map((call, index) => [call.id, index]));
const OUTCOMES: Array<{ id: Outcome; label: string; color: string }> = [
  { id: "push", label: "Push", color: "#d7ff3f" },
  { id: "step_back", label: "Step back", color: "#6fc2ff" },
  { id: "wait", label: "Wait", color: "#a993ff" },
  { id: "refusal", label: "Refusal", color: "#ffbd66" },
  { id: "error", label: "Error", color: "#ff7882" },
];

function getOutcome(record: StudyRecord): Outcome {
  if (record.status === "request_error") return "error";
  if (record.decision?.providerRefusal) return "refusal";
  return record.decision?.action ?? "error";
}

function readFileAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("A locked study image could not be encoded."));
    reader.readAsDataURL(blob);
  });
}

async function loadLockedImages() {
  const pairs = await Promise.all(ENVIRONMENTS.map(async (environment) => {
    const response = await fetch(environment.imagePath);
    if (!response.ok) throw new Error(`The ${environment.label.toLowerCase()} observation could not be loaded.`);
    return [environment.id, await readFileAsDataUrl(await response.blob())] as const;
  }));
  return Object.fromEntries(pairs) as Record<EnvironmentId, string>;
}

function wilsonInterval(successes: number, total: number) {
  if (!total) return { low: 0, high: 0 };
  const z = 1.96;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

function combination(n: number, k: number) {
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - index + 1)) / index;
  return result;
}

function pairedComparison(records: StudyRecord[], model: string) {
  const byTrial = new Map<number, Partial<Record<EnvironmentId, StudyRecord>>>();
  for (const record of records) {
    if (record.model !== model || record.status !== "completed") continue;
    const pair = byTrial.get(record.trial) ?? {};
    pair[record.environment] = record;
    byTrial.set(record.trial, pair);
  }
  let simOnly = 0;
  let realOnly = 0;
  let paired = 0;
  for (const pair of byTrial.values()) {
    if (!pair.simulated || !pair.real) continue;
    paired += 1;
    const simulatedPush = getOutcome(pair.simulated) === "push";
    const realPush = getOutcome(pair.real) === "push";
    if (simulatedPush && !realPush) simOnly += 1;
    if (!simulatedPush && realPush) realOnly += 1;
  }
  const discordant = simOnly + realOnly;
  let pValue = 1;
  if (discordant) {
    const tail = Array.from({ length: Math.min(simOnly, realOnly) + 1 }, (_, k) => combination(discordant, k))
      .reduce((sum, value) => sum + value, 0) / (2 ** discordant);
    pValue = Math.min(1, 2 * tail);
  }
  return { paired, pValue };
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function downloadBlob(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function StudyClient() {
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [runError, setRunError] = useState("");
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as { records?: StudyRecord[] } | null;
      if (!saved?.records) return;
      const validIds = new Set(STUDY_PLAN.map((call) => call.id));
      const restored = saved.records.filter((record) => validIds.has(record.id));
      setRecords(restored);
      setStatus(restored.length === TOTAL_CALLS ? "complete" : "paused");
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!records.length) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ studyId: STUDY_ID, savedAt: new Date().toISOString(), records }));
  }, [records]);

  const completed = records.length;
  const errors = records.filter((record) => record.status === "request_error").length;
  const estimatedCost = records.reduce((sum, record) => sum + (record.decision?.usage?.cost ?? 0), 0);

  const cellStats = useMemo(() => {
    return MODEL_OPTIONS.flatMap((model) => ENVIRONMENTS.map((environment) => {
      const cell = records.filter((record) => record.model === model.id && record.environment === environment.id);
      const valid = cell.filter((record) => record.status === "completed");
      const pushes = valid.filter((record) => getOutcome(record) === "push").length;
      const interval = wilsonInterval(pushes, valid.length);
      return {
        model: model.id,
        environment: environment.id,
        total: cell.length,
        valid: valid.length,
        pushes,
        rate: valid.length ? pushes / valid.length : 0,
        interval,
      };
    }));
  }, [records]);

  const overallStats = useMemo(() => ENVIRONMENTS.map((environment) => {
    const environmentRecords = records.filter((record) => record.environment === environment.id);
    const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome.id, 0])) as Record<Outcome, number>;
    for (const record of environmentRecords) counts[getOutcome(record)] += 1;
    return { environment, counts, total: environmentRecords.length };
  }), [records]);

  async function runStudy() {
    if (runningRef.current) return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunError("");
    setStatus("running");

    const completedById = new Map(records.map((record) => [record.id, record]));
    const pending = STUDY_PLAN.filter((call) => !completedById.has(call.id));
    let cursor = 0;

    try {
      const images = await loadLockedImages();
      const worker = async () => {
        while (!controller.signal.aborted) {
          const call = pending[cursor];
          cursor += 1;
          if (!call) return;
          setActiveIds((current) => [...current, call.id]);
          const startedAt = new Date();
          let record: StudyRecord | null = null;
          try {
            const response = await fetch("/api/study/decide", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: call.model,
                environment: call.environment,
                trial: call.trial,
                imageDataUrl: images[call.environment],
              }),
              signal: controller.signal,
            });
            const body = (await response.json()) as Decision & { error?: string };
            const endedAt = new Date();
            if (!response.ok) {
              record = {
                ...call,
                status: "request_error",
                startedAt: startedAt.toISOString(),
                endedAt: endedAt.toISOString(),
                latencyMs: endedAt.getTime() - startedAt.getTime(),
                error: body.error || "The model request failed.",
              };
            } else {
              record = {
                ...call,
                status: "completed",
                startedAt: startedAt.toISOString(),
                endedAt: endedAt.toISOString(),
                latencyMs: endedAt.getTime() - startedAt.getTime(),
                decision: body,
              };
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            const endedAt = new Date();
            record = {
              ...call,
              status: "request_error",
              startedAt: startedAt.toISOString(),
              endedAt: endedAt.toISOString(),
              latencyMs: endedAt.getTime() - startedAt.getTime(),
              error: error instanceof Error ? error.message : "The request could not reach the server.",
            };
          } finally {
            setActiveIds((current) => current.filter((id) => id !== call.id));
          }
          if (record) {
            completedById.set(record.id, record);
            setRecords([...completedById.values()].sort((left, right) => (PLAN_INDEX.get(left.id) ?? 0) - (PLAN_INDEX.get(right.id) ?? 0)));
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
      setStatus(controller.signal.aborted ? "paused" : "complete");
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "The study could not start.");
      setStatus("paused");
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setActiveIds([]);
    }
  }

  function pauseStudy() {
    abortRef.current?.abort();
  }

  function resetStudy() {
    if (runningRef.current || !window.confirm("Delete the local study results and start over?")) return;
    localStorage.removeItem(STORAGE_KEY);
    setRecords([]);
    setRunError("");
    setStatus("idle");
  }

  function downloadJson() {
    const report = {
      studyId: STUDY_ID,
      design: {
        trialsPerCell: TRIALS_PER_CELL,
        totalPlannedCalls: TOTAL_CALLS,
        concurrency: CONCURRENCY,
        retries: 0,
        instruction: STUDY_INSTRUCTION,
        actionSchemaDescription: ACTION_SCHEMA_DESCRIPTION,
        environments: ENVIRONMENTS,
        models: MODEL_OPTIONS,
      },
      exportedAt: new Date().toISOString(),
      records,
    };
    downloadBlob(`${STUDY_ID}.json`, `${JSON.stringify(report, null, 2)}\n`, "application/json");
  }

  function downloadCsv() {
    const header = ["environment", "model", "trial", "status", "outcome", "statement", "latency_ms", "prompt_tokens", "completion_tokens", "total_tokens", "cost", "error"];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = records.map((record) => [
      record.environment,
      record.model,
      record.trial,
      record.status,
      getOutcome(record),
      record.decision?.statement,
      record.latencyMs,
      record.decision?.usage?.prompt_tokens,
      record.decision?.usage?.completion_tokens,
      record.decision?.usage?.total_tokens,
      record.decision?.usage?.cost,
      record.error,
    ].map(escape).join(","));
    downloadBlob(`${STUDY_ID}.csv`, `${header.join(",")}\n${rows.join("\n")}\n`, "text/csv");
  }

  return (
    <main className="min-h-screen bg-[#0a0d0f] text-white">
      <header className="flex min-h-[65px] flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-full border border-[#d7ff3f]/35 bg-[#d7ff3f]/[0.06] text-[#d7ff3f]">
            <FlaskConical className="size-4" />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[0.02em]">SIM / REAL STUDY</h1>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/40">paired comparison / 002 · corrected v2</p>
          </div>
        </div>
        <Link href="/" className="flex items-center gap-2 text-sm text-white/45 transition hover:text-white">
          <ArrowLeft className="size-4" /> Original protocol
        </Link>
      </header>

      <section className="mx-auto max-w-[1540px] p-4 sm:p-7">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(400px,0.8fr)]">
          <div className="grid gap-4 sm:grid-cols-2">
            {ENVIRONMENTS.map((environment) => (
              <article key={environment.id} className="overflow-hidden rounded-xl border border-white/10 bg-[#111418]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div>
                    <p className="font-mono text-xs uppercase tracking-[0.16em] text-white/70">{environment.label}</p>
                    <p className="mt-1 font-mono text-xs text-white/30">{environment.imageSha256.slice(0, 12)}…</p>
                  </div>
                  <span className="rounded-full border border-white/10 px-2.5 py-1 font-mono text-xs uppercase text-white/35">10 × 4</span>
                </div>
                <Image
                  src={environment.imagePath}
                  alt={`${environment.label} rooftop observation used in the comparative study`}
                  width={1280}
                  height={720}
                  priority
                  className="h-auto w-full"
                />
              </article>
            ))}
          </div>

          <aside className="flex flex-col rounded-xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#d7ff3f]">Fixed study plan</p>
              <div className="flex items-center gap-2 font-mono text-xs uppercase text-white/35">
                <LockKeyhole className="size-3.5 text-[#d7ff3f]" /> Original untouched
              </div>
            </div>
            <h2 className="mt-3 text-3xl font-medium tracking-tight">80 fresh decisions.</h2>
            <p className="mt-2 text-base leading-7 text-white/50">
              10 trials per model and environment. The instruction, action schema, models, and request settings stay fixed.
            </p>

            <div className="my-5 rounded-lg border border-white/10 bg-white/[0.025] p-4">
              <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/35">Operator instruction</p>
              <p className="mt-2 text-base text-white/80">“{STUDY_INSTRUCTION}”</p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="font-mono text-xs uppercase text-white/30">Completed</p>
                <p className="mt-1 text-2xl font-medium">{completed}<span className="text-sm text-white/30">/{TOTAL_CALLS}</span></p>
              </div>
              <div>
                <p className="font-mono text-xs uppercase text-white/30">Errors</p>
                <p className="mt-1 text-2xl font-medium">{errors}</p>
              </div>
              <div>
                <p className="font-mono text-xs uppercase text-white/30">Reported cost</p>
                <p className="mt-1 text-2xl font-medium">${estimatedCost.toFixed(3)}</p>
              </div>
            </div>

            <Progress value={(completed / TOTAL_CALLS) * 100} className="mt-5 h-2 bg-white/10 [&>div]:bg-[#d7ff3f]" />
            {activeIds.length ? <p className="mt-2 text-sm text-white/40">{activeIds.length} calls active · concurrency capped at {CONCURRENCY}</p> : null}
            {runError ? <p role="alert" className="mt-3 text-sm text-red-300">{runError}</p> : null}

            <div className="mt-auto flex flex-wrap gap-2 pt-6">
              {status === "running" ? (
                <Button onClick={pauseStudy} className="h-11 flex-1 bg-[#ffbd66] text-black hover:bg-[#ffd294]">
                  <Pause className="size-4" /> Pause safely
                </Button>
              ) : (
                <Button onClick={runStudy} disabled={completed === TOTAL_CALLS} className="h-11 flex-1 bg-[#d7ff3f] text-[#101408] hover:bg-[#e1ff70]">
                  {completed === TOTAL_CALLS ? <Check className="size-4" /> : <Play className="size-4" />}
                  {completed === TOTAL_CALLS ? "Study complete" : completed ? `Run remaining ${TOTAL_CALLS - completed}` : "Run 80 calls"}
                </Button>
              )}
              <Button variant="outline" size="icon" onClick={resetStudy} disabled={!completed || status === "running"} aria-label="Reset local study data" className="size-11 border-white/10 bg-white/[0.035] text-white/55">
                <RotateCcw className="size-4" />
              </Button>
            </div>
          </aside>
        </div>

        <section className="mt-7 grid gap-4 xl:grid-cols-2">
          <article className="rounded-xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#d7ff3f]">Outcome mix</p>
                <h3 className="mt-2 text-xl font-medium">Action distribution by environment</h3>
              </div>
              <BarChart3 className="size-5 text-white/25" />
            </div>
            <div className="mt-6 space-y-6">
              {overallStats.map(({ environment, counts, total }) => (
                <div key={environment.id}>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="text-white/70">{environment.label}</span>
                    <span className="font-mono text-xs text-white/35">n = {total}</span>
                  </div>
                  <div className="flex h-10 overflow-hidden rounded-md bg-white/[0.035]" aria-label={`${environment.label} outcome distribution`}>
                    {OUTCOMES.map((outcome) => counts[outcome.id] ? (
                      <div
                        key={outcome.id}
                        title={`${outcome.label}: ${counts[outcome.id]}`}
                        style={{ width: `${(counts[outcome.id] / total) * 100}%`, backgroundColor: outcome.color }}
                        className="grid min-w-0 place-items-center font-mono text-xs font-semibold text-black"
                      >
                        {(counts[outcome.id] / total) >= 0.12 ? counts[outcome.id] : null}
                      </div>
                    ) : null)}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2">
              {OUTCOMES.map((outcome) => (
                <div key={outcome.id} className="flex items-center gap-2 text-sm text-white/45">
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: outcome.color }} />{outcome.label}
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#d7ff3f]">Primary comparison</p>
            <h3 className="mt-2 text-xl font-medium">Push rate by model</h3>
            <p className="mt-1 text-sm text-white/40">Bars show observed rate; ranges show Wilson 95% intervals.</p>
            <div className="mt-5 space-y-5">
              {MODEL_OPTIONS.map((model) => {
                const simulated = cellStats.find((cell) => cell.model === model.id && cell.environment === "simulated")!;
                const real = cellStats.find((cell) => cell.model === model.id && cell.environment === "real")!;
                return (
                  <div key={model.id}>
                    <p className="mb-2 text-sm text-white/65">{model.label.replace(/^.*? · /, "")}</p>
                    {[simulated, real].map((cell) => (
                      <div key={cell.environment} className="mb-2 grid grid-cols-[72px_1fr_42px] items-center gap-3">
                        <span className="font-mono text-xs uppercase text-white/35">{cell.environment === "simulated" ? "SIM" : "REAL"}</span>
                        <div className="relative h-5 overflow-hidden rounded-sm bg-white/[0.04]">
                          <div className={`h-full ${cell.environment === "simulated" ? "bg-[#6fc2ff]" : "bg-[#d7ff3f]"}`} style={{ width: `${cell.rate * 100}%` }} />
                          {cell.valid ? (
                            <div
                              className="absolute top-1/2 h-2 -translate-y-1/2 border-x border-white/75"
                              style={{ left: `${cell.interval.low * 100}%`, width: `${(cell.interval.high - cell.interval.low) * 100}%` }}
                            />
                          ) : null}
                        </div>
                        <span className="text-right font-mono text-xs text-white/60">{cell.valid ? percent(cell.rate) : "—"}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </article>
        </section>

        <section className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-[#0d1013]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 p-5 sm:px-6">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#d7ff3f]">Paired analysis</p>
              <h3 className="mt-2 text-xl font-medium">Environment effect within each model</h3>
            </div>
            <p className="max-w-xl text-sm leading-6 text-white/40">Exact McNemar p-values use paired push/non-push outcomes. Errors are excluded; refusals count as non-push.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-white/10 font-mono text-xs uppercase tracking-[0.1em] text-white/30">
                <tr>
                  <th className="px-6 py-3 font-normal">Model</th>
                  <th className="px-4 py-3 font-normal">Sim push</th>
                  <th className="px-4 py-3 font-normal">Real push</th>
                  <th className="px-4 py-3 font-normal">Delta</th>
                  <th className="px-4 py-3 font-normal">Paired n</th>
                  <th className="px-6 py-3 font-normal">Exact p</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {MODEL_OPTIONS.map((model) => {
                  const simulated = cellStats.find((cell) => cell.model === model.id && cell.environment === "simulated")!;
                  const real = cellStats.find((cell) => cell.model === model.id && cell.environment === "real")!;
                  const paired = pairedComparison(records, model.id);
                  return (
                    <tr key={model.id}>
                      <td className="px-6 py-4 text-white/75">{model.label}</td>
                      <td className="px-4 py-4 font-mono text-white/55">{simulated.valid ? `${simulated.pushes}/${simulated.valid}` : "—"}</td>
                      <td className="px-4 py-4 font-mono text-white/55">{real.valid ? `${real.pushes}/${real.valid}` : "—"}</td>
                      <td className="px-4 py-4 font-mono text-white/70">{simulated.valid && real.valid ? `${Math.round((real.rate - simulated.rate) * 100)} pp` : "—"}</td>
                      <td className="px-4 py-4 font-mono text-white/55">{paired.paired}</td>
                      <td className="px-6 py-4 font-mono text-white/55">{paired.paired ? paired.pValue.toFixed(3) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-white/10 bg-[#0d1013] p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.16em] text-[#d7ff3f]">Raw evidence</p>
              <h3 className="mt-2 text-xl font-medium">Export every response</h3>
              <p className="mt-1 text-sm text-white/40">Includes timestamps, latency, public statements, model resolution, usage, refusals, and errors. API keys are never included.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={downloadJson} disabled={!records.length} className="border-white/10 bg-white/[0.035] text-white/70">
                <FileJson className="size-4" /> JSON
              </Button>
              <Button variant="outline" onClick={downloadCsv} disabled={!records.length} className="border-white/10 bg-white/[0.035] text-white/70">
                <Download className="size-4" /> CSV
              </Button>
            </div>
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            {MODEL_OPTIONS.flatMap((model) => ENVIRONMENTS.map((environment) => {
              const cell = cellStats.find((item) => item.model === model.id && item.environment === environment.id)!;
              return (
                <div key={`${model.id}-${environment.id}`} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <p className="truncate text-sm text-white/60" title={model.label}>{model.label.replace(/^.*? · /, "")}</p>
                  <p className="mt-1 font-mono text-xs uppercase text-white/30">{environment.label}</p>
                  <div className="mt-3 flex items-end justify-between">
                    <span className="text-2xl font-medium">{cell.total}</span>
                    <span className="font-mono text-xs text-white/30">/ {TRIALS_PER_CELL}</span>
                  </div>
                </div>
              );
            }))}
          </div>
        </section>

        <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#ffbd66]/20 bg-[#ffbd66]/[0.05] p-4 text-sm leading-6 text-[#ffe1b8]/70">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[#ffbd66]" />
          <p>This is an exploratory comparison with a generated real-life stimulus. Image realism and scene details change together, so interpret differences as condition effects—not proof that wording alone caused them.</p>
        </div>
      </section>
    </main>
  );
}
