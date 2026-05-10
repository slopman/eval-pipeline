import { describe, expect, it } from "vitest";

import {
  createStagingOnBotStatusHook,
  finalizeStagingManifest,
  newStagingManifest,
  stagingManifestToJson,
  summarizeGraphFinalState,
} from "./run-manifest.js";

describe("run-manifest (staging JSON)", () => {
  it("newStagingManifest initializes schema and empty telegram_side_effects", () => {
    const m = newStagingManifest({
      scenario_id: "smoke",
      staging_chat_id: "staging-999001",
      session_id: "sess-a",
    });
    expect(m.schema_version).toBe(1);
    expect(m.run_id.length).toBeGreaterThan(10);
    expect(m.telegram_side_effects).toEqual([]);
    expect(m.started_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("createStagingOnBotStatusHook records lines without Telegram delivery", async () => {
    const m = newStagingManifest({
      scenario_id: "hook",
      staging_chat_id: "x",
      session_id: "y",
    });
    const hook = createStagingOnBotStatusHook(m);
    await hook("✨ test: hello…");
    await hook("second line");
    expect(m.telegram_side_effects).toHaveLength(2);
    expect(m.telegram_side_effects[0]!.would_deliver_to_telegram).toBe(false);
    expect(m.telegram_side_effects[0]!.kind).toBe("bot_status");
    expect(m.telegram_side_effects[0]!.line).toContain("hello");
  });

  it("finalizeStagingManifest sets finished_at and outcome", () => {
    const m = newStagingManifest({
      scenario_id: "fin",
      staging_chat_id: "1",
      session_id: "2",
    });
    finalizeStagingManifest(m, {
      next_action: "CHAT",
      draft_chars: 42,
      leader_comment_chars: 7,
      client_geo_fingerprint: "abc",
    });
    expect(m.finished_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.outcome?.next_action).toBe("CHAT");
    expect(m.outcome?.draft_chars).toBe(42);
  });

  it("summarizeGraphFinalState picks key fields from LangGraph state", () => {
    const s = summarizeGraphFinalState({
      nextAction: "RESEARCH",
      draft: "abcd",
      leaderComment: "hi",
      clientGeoFingerprint: " fp1 ",
    });
    expect(s.next_action).toBe("RESEARCH");
    expect(s.draft_chars).toBe(4);
    expect(s.leader_comment_chars).toBe(2);
    expect(s.client_geo_fingerprint).toBe("fp1");
  });

  it("stagingManifestToJson is stable round-trip shape", () => {
    const m = newStagingManifest({
      scenario_id: "json",
      staging_chat_id: "c",
      session_id: "s",
      telegram_user_id: "404",
    });
    const raw = stagingManifestToJson(m);
    const parsed = JSON.parse(raw) as { schema_version: number; meta: { scenario_id: string } };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.meta.scenario_id).toBe("json");
  });
});
