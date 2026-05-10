import { describe, expect, it } from "vitest";

import {
  chartPipelineInputFromFixture,
  loadNatalFixture,
  resolveNatalFixturePath,
} from "./natal-fixture-for-staging.js";

describe("natal-fixture-for-staging", () => {
  it("resolves steve_jobs.json path", () => {
    const p = resolveNatalFixturePath("steve_jobs");
    expect(p).toContain("steve_jobs.json");
  });

  it("loads Steve Jobs fixture", () => {
    const f = loadNatalFixture("steve_jobs");
    expect(f.name).toBe("Steve Jobs");
    expect(f.birth_data.date_iso).toMatch(/^1955-/);
  });

  it("chartPipelineInputFromFixture adds default city for steve_jobs", () => {
    const i = chartPipelineInputFromFixture("steve_jobs");
    expect(i.city).toContain("San Francisco");
    expect(i.name).toBe("Steve Jobs");
  });

  it("uses city from JSON when present", () => {
    const i = chartPipelineInputFromFixture("albert_einstein");
    expect(i.city).toContain("Ulm");
  });
});
