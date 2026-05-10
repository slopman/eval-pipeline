import { describe, expect, it } from "vitest";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { emitBotStatus } from "../agentic_rag/graph.js";
import { createStagingOnBotStatusHook, newStagingManifest } from "./run-manifest.js";

describe("staging graph hooks vs emitBotStatus", () => {
  it("emitBotStatus forwards lines into staging manifest when onBotStatus is set", async () => {
    const manifest = newStagingManifest({
      scenario_id: "emit-bridge",
      staging_chat_id: "staging-hooks",
      session_id: "sess-hooks",
    });
    const hook = createStagingOnBotStatusHook(manifest);
    const config = {
      configurable: {
        onBotStatus: hook,
      },
    } as LangGraphRunnableConfig;

    await emitBotStatus(config, "✨ Bot: typing…");
    await emitBotStatus(config, "another");

    expect(manifest.telegram_side_effects).toHaveLength(2);
    expect(manifest.telegram_side_effects[0]!.line).toContain("typing");
  });
});

/**
 * Полный прогон appGraph — реальные LLM и БД. Включить явно:
 *   STAGING_GRAPH_E2E=1 npm test -- src/staging/staging-graph-invoke.test.ts
 */
const e2eEnabled =
  process.env.STAGING_GRAPH_E2E === "1" || process.env.STAGING_GRAPH_E2E === "true";

describe.skipIf(!e2eEnabled)("runStagingGraphInvoke (e2e, optional)", () => {
  it(
    "runs one graph turn and collects bot_status lines in manifest",
    async () => {
      const { runStagingGraphInvoke } = await import("./staging-graph-invoke.js");

      const chatId = process.env.STAGING_CHAT_ID?.trim() || "staging-e2e-000001";
      const sessionId = process.env.STAGING_SESSION_ID?.trim() || "staging-session";

      const { manifest, finalState } = await runStagingGraphInvoke({
        scenarioId: "e2e_min_chat",
        userQuery:
          "Привет, это автономный прогон стенда. Ответь одним коротким предложением.",
        telegramChatId: chatId,
        sessionId,
        telegramUserId: process.env.STAGING_TELEGRAM_USER_ID?.trim() || "999001",
        recursionLimit: 40,
        notes: "vitest STAGING_GRAPH_E2E",
        collectTrace: true,
      });

      expect(manifest.schema_version).toBe(1);
      expect(manifest.finished_at_iso).toBeDefined();
      expect(manifest.telegram_side_effects.length).toBeGreaterThan(0);
      expect(typeof finalState.draft === "string" ? finalState.draft : "").toBeTruthy();
      expect(manifest.graph_steps?.length).toBeGreaterThan(0);
      expect(manifest.llm_call_records?.length).toBeGreaterThan(0);
      expect(manifest.automated_checks?.length).toBeGreaterThan(0);
      expect(manifest.final_state_visible_bundle).toBeDefined();
      for (const step of manifest.graph_steps ?? []) {
        expect(step.state_visible_bundle).toBeDefined();
        expect(Object.keys(step.state_visible_bundle ?? {}).length).toBeGreaterThan(0);
      }
    },
    180_000
  );
});
