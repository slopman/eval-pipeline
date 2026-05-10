/**
 * Прогон графа со знаменитостью из __fixtures__/natal-charts:
 * 1) runClientChartPipeline → geo_snapshots для staging chat/session (можно --skip-chart)
 * 2) runStagingGraphInvoke: супервизор **всегда** получает принудительный CHART с данными фикстуры → в графе вызывается **chartMaker**
 *    (пересчёт, prefetch, астропаспорт), затем proLead — как полный боевой контур карты.
 *
 * Из astro_bot:
 *   npm run staging:fixture -- --fixture steve_jobs
 *   npm run staging:fixture -- --fixture albert_einstein "Кратко: лагна и Луна?"
 *
 * Опции:
 *   --fixture <id>   steve_jobs | albert_einstein | marilyn_monroe | queen_elizabeth_ii
 *   --skip-chart     не вызывать runClientChartPipeline (geo уже есть для этого chat/session)
 *   --cold-start     очистить astro-кэш SQLite для STAGING_CHAT_ID и пропустить шаг 1 (как «новый» клиент без карты)
 *   --no-trace       только invoke графа
 *   --composer       Composer 2 по каждому шагу после графа (CURSOR_API_KEY; несовместимо с --no-trace)
 *
 * Env: как staging-graph-cli (STAGING_OUT_DIR, STAGING_CHAT_ID, STAGING_SESSION_ID, …).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

import { runClientChartPipeline } from "../agentic_rag/tools.js";
import {
  chartPipelineInputFromFixture,
  isStagingNatalFixtureId,
  STAGING_NATAL_FIXTURE_IDS,
  type StagingNatalFixtureId,
} from "./natal-fixture-for-staging.js";
import { clearTelegramChatAstroCache } from "../db/clear-telegram-chat-astro-cache.js";
import { getDb } from "../db/index.js";
import { stagingManifestToJson } from "./run-manifest.js";
import { runStagingGraphInvoke } from "./staging-graph-invoke.js";

function printHelp(): void {
  console.log(`staging-fixture-graph-cli — карта из фикстуры + один оборот appGraph.

Шаги:
  1) runClientChartPipeline (геокод + calculate_geo_positions + geo_snapshots в SQLite)
  2) runStagingGraphInvoke (манифест со стенд-трейсом)

Использование:
  npm run staging:fixture -- [--fixture steve_jobs] ["запрос пользователя"]

Опции:
  --fixture <id>   один из: ${STAGING_NATAL_FIXTURE_IDS.join(", ")}
  --skip-chart     пропустить шаг 1 (если снимок уже есть для chat/session)
  --cold-start     очистить astro-кэш SQLite для STAGING_CHAT_ID и пропустить шаг 1 (без geo до графа)
  --no-trace       граф без graph_steps / llm_call_records
  --composer       после графа — аудит Composer по шагам (см. staging-composer-skin.ts)
  --out <dir>      каталог артефактов (по умолчанию ./staging-runs)
  --scenario <id>  поле meta.scenario_id в манифесте
  -h, --help

Переменные: STAGING_CHAT_ID, STAGING_SESSION_ID (желательно задать для воспроизводимости),
  STAGING_TELEGRAM_USER_ID, STAGING_OUT_DIR, STAGING_RECURSION_LIMIT, …
`);
}

function parseCli(argv: string[]): {
  fixtureId: StagingNatalFixtureId;
  skipChart: boolean;
  coldStart: boolean;
  collectTrace: boolean;
  composerSkin: boolean;
  outDir: string;
  scenarioId: string;
  queryParts: string[];
} {
  let fixtureId: StagingNatalFixtureId = "steve_jobs";
  let skipChart = false;
  let coldStart = false;
  let collectTrace = true;
  let composerSkin = false;
  let outDir = process.env.STAGING_OUT_DIR?.trim() || path.join(process.cwd(), "staging-runs");
  let scenarioId = "";
  const queryParts: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
    if (a === "--skip-chart") {
      skipChart = true;
      continue;
    }
    if (a === "--cold-start") {
      coldStart = true;
      skipChart = true;
      continue;
    }
    if (a === "--no-trace") {
      collectTrace = false;
      continue;
    }
    if (a === "--composer") {
      composerSkin = true;
      collectTrace = true;
      continue;
    }
    if (a === "--fixture") {
      const next = argv[++i];
      if (!next || !isStagingNatalFixtureId(next)) {
        throw new Error(
          `--fixture требует id из: ${STAGING_NATAL_FIXTURE_IDS.join(", ")}`
        );
      }
      fixtureId = next;
      continue;
    }
    if (a === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out требует путь");
      outDir = path.resolve(process.cwd(), next);
      continue;
    }
    if (a === "--scenario") {
      const next = argv[++i];
      if (!next) throw new Error("--scenario требует id");
      scenarioId = next;
      continue;
    }
    queryParts.push(a);
  }

  if (!scenarioId.trim()) {
    scenarioId = coldStart ? `fixture_${fixtureId}_cold` : `fixture_${fixtureId}`;
  }

  return {
    fixtureId,
    skipChart,
    coldStart,
    collectTrace,
    composerSkin,
    outDir,
    scenarioId,
    queryParts,
  };
}

async function main(): Promise<void> {
  const {
    fixtureId,
    skipChart,
    coldStart,
    collectTrace,
    composerSkin,
    outDir,
    scenarioId,
    queryParts,
  } = parseCli(process.argv);

  const chatId =
    process.env.STAGING_CHAT_ID?.trim() || `staging-fixture-${fixtureId}`;
  const sessionId =
    process.env.STAGING_SESSION_ID?.trim() || `staging-fixture-sess-${fixtureId}`;
  const telegramUserId = process.env.STAGING_TELEGRAM_USER_ID?.trim() || "999001";
  const crmOverride = process.env.STAGING_CRM_OVERRIDE_CLIENT_ID?.trim();
  const calcCtx = process.env.STAGING_CALC_CONTEXT_CLIENT_ID?.trim();
  const recRaw = process.env.STAGING_RECURSION_LIMIT?.trim();
  const recursionLimit = recRaw ? Number.parseInt(recRaw, 10) : 60;
  if (recRaw && (!Number.isFinite(recursionLimit) || recursionLimit < 1)) {
    throw new Error(`Invalid STAGING_RECURSION_LIMIT: ${recRaw}`);
  }

  const userQuery =
    queryParts.join(" ").trim() ||
    process.env.STAGING_QUERY?.trim() ||
    `Кратко опиши натальную карту (${fixtureId}): лагна, знак Луны и одну заметную связку планет. Ответ по-русски, без воды.`;

  if (composerSkin && !collectTrace) {
    throw new Error("--composer требует трейс графа (уберите --no-trace)");
  }

  console.error(
    `[staging-fixture] fixture=${fixtureId} chat=${chatId} session=${sessionId} skipChart=${skipChart} coldStart=${coldStart} collectTrace=${collectTrace} composerSkin=${composerSkin}`
  );

  if (coldStart) {
    const db = getDb();
    const cleared = clearTelegramChatAstroCache(db, chatId);
    console.error(`[staging-fixture] cold-start cleared astro cache for chat=${chatId}`, cleared);
  }

  const chartIn = chartPipelineInputFromFixture(fixtureId);

  if (!skipChart) {
    console.error(
      `[staging-fixture] runClientChartPipeline: ${chartIn.name}, ${chartIn.date}, ${chartIn.city}`
    );
    const pipelineRaw = await runClientChartPipeline(chartIn, {
      telegramChatId: chatId,
      sessionId,
    });
    if (
      pipelineRaw.includes("Geocode failed") ||
      pipelineRaw.includes("Planetary calculation failed")
    ) {
      console.error("[staging-fixture] chart pipeline failed:\n", pipelineRaw.slice(0, 2000));
      process.exit(1);
    }
    console.error("[staging-fixture] chart pipeline OK");
  }

  const { manifest } = await runStagingGraphInvoke({
    scenarioId,
    userQuery,
    telegramChatId: chatId,
    sessionId,
    telegramUserId,
    ...(crmOverride ? { crmOverrideClientId: crmOverride } : {}),
    ...(calcCtx ? { calculationContextClientId: calcCtx } : {}),
    recursionLimit,
    collectTrace,
    composerSkin,
    stagingFixtureChartThroughGraph: chartIn,
    notes: `staging-fixture-graph-cli fixture=${fixtureId}${coldStart ? " cold-start" : ""}`,
  });

  const runDir = path.join(outDir, manifest.run_id);
  mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, "manifest.json");
  writeFileSync(manifestPath, stagingManifestToJson(manifest), "utf8");

  console.log(manifestPath);
  const composerAudits = (manifest.graph_steps ?? []).filter(
    (s) =>
      (s.composer_skin_notes && !s.composer_skin_notes.startsWith("[skipped]")) ||
      Boolean(s.composer_skin_error)
  ).length;
  console.error(
    `[staging-fixture] done run_id=${manifest.run_id} steps=${manifest.graph_steps?.length ?? 0} llm_calls=${manifest.llm_call_records?.length ?? 0} composer_audits=${composerAudits}`
  );
}

main().catch((e) => {
  console.error("[staging-fixture] failed:", e);
  process.exit(1);
});
