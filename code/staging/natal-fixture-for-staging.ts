/**
 * Натальные фикстуры из Vitest (`src/__fixtures__/natal-charts`) для стенда графа.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Те же id, что в scripts/mcp-celebrity-report.ts */
export const STAGING_NATAL_FIXTURE_IDS = [
  "steve_jobs",
  "albert_einstein",
  "marilyn_monroe",
  "queen_elizabeth_ii",
] as const;

export type StagingNatalFixtureId = (typeof STAGING_NATAL_FIXTURE_IDS)[number];

export type NatalFixtureBirthData = {
  date_iso: string;
  lat: number;
  lon: number;
  city?: string;
};

export type NatalFixtureFile = {
  name: string;
  birth_data: NatalFixtureBirthData;
  settings?: { ayanamsa?: string; house_system?: string };
};

/** У Steve Jobs в JSON нет города — нужен для geocode в runClientChartPipeline. */
const DEFAULT_CITY_BY_FIXTURE: Partial<Record<StagingNatalFixtureId, string>> = {
  steve_jobs: "San Francisco, CA, USA",
};

export function isStagingNatalFixtureId(s: string): s is StagingNatalFixtureId {
  return (STAGING_NATAL_FIXTURE_IDS as readonly string[]).includes(s);
}

export function resolveNatalFixturePath(fixtureId: StagingNatalFixtureId): string {
  return path.resolve(__dirname, "../__fixtures__/natal-charts", `${fixtureId}.json`);
}

export function loadNatalFixture(fixtureId: StagingNatalFixtureId): NatalFixtureFile {
  const p = resolveNatalFixturePath(fixtureId);
  return JSON.parse(readFileSync(p, "utf8")) as NatalFixtureFile;
}

/** Вход для runClientChartPipeline (как у бота: имя, локальная дата/время строкой, город для геокодера). */
export function chartPipelineInputFromFixture(fixtureId: StagingNatalFixtureId): {
  name: string;
  date: string;
  city: string;
} {
  const f = loadNatalFixture(fixtureId);
  const city =
    f.birth_data.city?.trim() ||
    DEFAULT_CITY_BY_FIXTURE[fixtureId]?.trim() ||
    (() => {
      throw new Error(
        `Фикстура ${fixtureId}: нет birth_data.city и нет дефолта города в staging — добавьте city в JSON или DEFAULT_CITY_BY_FIXTURE.`
      );
    })();
  return {
    name: f.name,
    date: f.birth_data.date_iso,
    city,
  };
}
