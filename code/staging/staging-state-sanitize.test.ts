import { describe, expect, it } from "vitest";

import { sanitizeForStagingJson } from "./staging-state-sanitize.js";

describe("sanitizeForStagingJson", () => {
  it("truncates long strings", () => {
    const s = "x".repeat(100);
    const out = sanitizeForStagingJson(s, { maxString: 20 }) as string;
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain("truncated");
  });

  it("summarizes BaseMessage-like objects by type and content", () => {
    const fake = {
      getType: () => "human",
      content: "hello world",
    };
    const out = sanitizeForStagingJson(fake) as { type: string; content: string };
    expect(out.type).toBe("human");
    expect(out.content).toBe("hello world");
  });
});
