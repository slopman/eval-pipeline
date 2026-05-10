import { describe, expect, it } from "vitest";

import {
  RAG_STATE_STAGING_VISIBLE_KEYS,
  buildRagStateVisibleBundle,
} from "./staging-rag-visible-bundle.js";

describe("buildRagStateVisibleBundle", () => {
  it("includes known RagState keys when present", () => {
    const state = {
      userQuery: "hello",
      nextAction: "CHAT",
      draft: "x".repeat(100),
      clientGeoDigest: "Lagna note",
      messages: [],
      unknown_field: "ignored",
    };
    const b = buildRagStateVisibleBundle(state);
    expect(b.userQuery).toBe("hello");
    expect(b.nextAction).toBe("CHAT");
    expect((b.draft as string).length).toBeGreaterThan(10);
    expect(b.clientGeoDigest).toBe("Lagna note");
    expect(b).not.toHaveProperty("unknown_field");
  });

  it("summarizes messages with tail_preview", () => {
    const fakeHuman = {
      getType: () => "human",
      content: "short",
    };
    const fakeAi = {
      getType: () => "ai",
      content: "long ".repeat(300),
    };
    const b = buildRagStateVisibleBundle({
      messages: [fakeHuman, fakeAi],
      sessionId: "s1",
    });
    const m = b.messages as { count: number; tail_preview: unknown[] };
    expect(m.count).toBe(2);
    expect(Array.isArray(m.tail_preview)).toBe(true);
    expect(m.tail_preview).toHaveLength(2);
    expect(String(JSON.stringify(m.tail_preview)).length).toBeGreaterThan(10);
  });

  it("key list matches bundle extraction cardinality for empty state", () => {
    expect(RAG_STATE_STAGING_VISIBLE_KEYS.length).toBeGreaterThan(30);
    const b = buildRagStateVisibleBundle({});
    expect(Object.keys(b)).toHaveLength(0);
  });
});
