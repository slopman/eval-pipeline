import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { HumanMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

import { appGraph } from "../agentic_rag/graph.js";
import type {
  StagingGraphStepRecord,
  StagingLlmCallRecord,
  StagingRunManifest,
} from "./run-manifest.js";
import { computeStagingAutomatedChecks } from "./staging-automated-checks.js";
import { buildRagStateVisibleBundle } from "./staging-rag-visible-bundle.js";
import { sanitizeForStagingJson } from "./staging-state-sanitize.js";
import { setStagingComposerGraphLlmRecordSink } from "../utils/staging-composer-graph-llm.js";

function serializedModelId(llm: Serialized): string | undefined {
  if (llm.type === "constructor" && "kwargs" in llm) {
    const kwargs = llm.kwargs as Record<string, unknown>;
    const m = kwargs.model ?? kwargs.modelName ?? kwargs.model_id;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (Array.isArray(llm.id)) return llm.id.filter((x) => typeof x === "string").join(".");
  return undefined;
}

function mergeNumericUsage(target: Record<string, number>, src: unknown): void {
  if (!src || typeof src !== "object") return;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) target[k] = v;
  }
}

function extractTokenUsage(output: LLMResult): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (output.llmOutput?.tokenUsage && typeof output.llmOutput.tokenUsage === "object") {
    mergeNumericUsage(out, output.llmOutput.tokenUsage);
  }
  for (const row of output.generations ?? []) {
    for (const g of row ?? []) {
      if (g?.generationInfo?.tokenUsage) {
        mergeNumericUsage(out, g.generationInfo.tokenUsage);
      }
      const msg = (g as ChatGeneration)?.message as
        | { response_metadata?: { usage?: unknown } }
        | undefined;
      if (msg?.response_metadata?.usage) {
        mergeNumericUsage(out, msg.response_metadata.usage);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function completionPreviewFromLlmResult(output: LLMResult, maxLen: number): string | undefined {
  const flat = output.generations?.flat() ?? [];
  for (const g of flat) {
    const msg = (g as ChatGeneration)?.message as { content?: unknown } | undefined;
    if (msg && typeof msg.content === "string" && msg.content.length) {
      const c = msg.content;
      return c.length > maxLen ? `${c.slice(0, maxLen)}…` : c;
    }
    if (g && "text" in g && typeof (g as { text?: string }).text === "string") {
      const t = (g as { text: string }).text;
      return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
    }
  }
  return undefined;
}

type PendingLlm = { model_hint?: string; started_at_iso: string };

export class StagingLlmTraceCallback extends BaseCallbackHandler {
  name = "StagingLlmTraceCallback";
  lc_serializable = false;

  private readonly records: StagingLlmCallRecord[];
  private readonly pending = new Map<string, PendingLlm>();

  constructor(target: StagingLlmCallRecord[]) {
    super();
    this.records = target;
  }

  handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string
  ): void {
    this.pending.set(runId, {
      model_hint: serializedModelId(llm),
      started_at_iso: new Date().toISOString(),
    });
  }

  handleChatModelStart(
    llm: Serialized,
    _messages: unknown,
    runId: string
  ): void {
    this.pending.set(runId, {
      model_hint: serializedModelId(llm),
      started_at_iso: new Date().toISOString(),
    });
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const pending = this.pending.get(runId);
    this.pending.delete(runId);
    this.records.push({
      run_id: runId,
      recorded_at_iso: new Date().toISOString(),
      model_id: pending?.model_hint,
      started_at_iso: pending?.started_at_iso,
      token_usage: extractTokenUsage(output),
      completion_preview: completionPreviewFromLlmResult(output, 1_200),
    });
  }

  handleLLMError(err: Error, runId: string): void {
    const pending = this.pending.get(runId);
    this.pending.delete(runId);
    this.records.push({
      run_id: runId,
      recorded_at_iso: new Date().toISOString(),
      model_id: pending?.model_hint,
      started_at_iso: pending?.started_at_iso,
      error: err?.message ?? String(err),
    });
  }
}

export type RunStagingGraphStreamOpts = {
  userQuery: string;
  sessionId: string;
  recursionLimit?: number;
  configurable: Record<string, unknown>;
};

/**
 * Один прогон графа через stream (updates + values) + callback на LLM.
 * Финальный state = последний chunk режима "values".
 */
export async function runStagingGraphStreamCollect(
  manifest: StagingRunManifest,
  opts: RunStagingGraphStreamOpts
): Promise<Record<string, unknown>> {
  manifest.graph_steps = [];
  manifest.llm_call_records = [];
  const llmRecords = manifest.llm_call_records;
  const llmCb = new StagingLlmTraceCallback(llmRecords);

  setStagingComposerGraphLlmRecordSink((rec) => llmRecords.push(rec));
  try {
    const stream = await appGraph.stream(
      {
        userQuery: opts.userQuery,
        messages: [new HumanMessage(opts.userQuery)],
        sessionId: opts.sessionId,
      },
      {
        recursionLimit: opts.recursionLimit ?? 60,
        streamMode: ["updates", "values"],
        configurable: {
          ...opts.configurable,
          callbacks: [llmCb],
        },
      }
    );

    let lastValues: Record<string, unknown> | undefined;
    let stepIndex = 0;
    const pendingSteps: StagingGraphStepRecord[] = [];

    for await (const chunk of stream) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const mode = chunk[0];
      const data = chunk[1] as Record<string, unknown>;

      if (mode === "values") {
        lastValues = data as Record<string, unknown>;
        const bundle = buildRagStateVisibleBundle(lastValues);

        if (
          manifest.initial_state_visible_bundle === undefined &&
          pendingSteps.length === 0 &&
          (manifest.graph_steps?.length ?? 0) === 0
        ) {
          manifest.initial_state_visible_bundle = bundle;
        }

        for (const s of pendingSteps) {
          s.state_visible_bundle = bundle;
        }
        pendingSteps.length = 0;
        continue;
      }

      if (mode !== "updates") continue;

      const meta = data.__metadata__ as { cached?: boolean } | undefined;
      const nodeIds = Object.keys(data).filter((k) => k !== "__metadata__");
      const step: StagingGraphStepRecord = {
        step_index: stepIndex++,
        recorded_at_iso: new Date().toISOString(),
        node_ids: nodeIds,
        update_visible: sanitizeForStagingJson(data) as Record<string, unknown>,
        from_cache: meta?.cached === true,
      };
      manifest.graph_steps.push(step);
      pendingSteps.push(step);
    }

    if (!lastValues) {
      throw new Error("staging graph stream: no values chunk (empty run?)");
    }

    manifest.final_state_visible_bundle = buildRagStateVisibleBundle(lastValues);

    const fallbackBundle = manifest.final_state_visible_bundle;
    for (const s of pendingSteps) {
      if (!s.state_visible_bundle) {
        s.state_visible_bundle = fallbackBundle;
      }
    }

    manifest.automated_checks = computeStagingAutomatedChecks(lastValues);
    return lastValues;
  } finally {
    setStagingComposerGraphLlmRecordSink(null);
  }
}
