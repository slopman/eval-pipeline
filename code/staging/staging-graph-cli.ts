/**
 * Автономный прогон графа и запись JSON-манифеста на диск (без Telegram API).
 *
 * Из каталога astro_bot:
 *   npm run staging:graph -- "Короткий тестовый запрос"
 *   npm run staging:graph -- --no-trace "только invoke"
 *   npm run staging:graph -- --out ./my-runs --scenario smoke_v1 "привет"
 *
 * Переменные окружения (дополнительно к .env бота):
 *   STAGING_OUT_DIR — корень каталога прогонов (по умолчанию ./staging-runs)
 *   STAGING_QUERY — текст, если не передан позиционным аргументом
 *   STAGING_SCENARIO_ID, STAGING_CHAT_ID, STAGING_SESSION_ID, STAGING_TELEGRAM_USER_ID
 *   STAGING_CRM_OVERRIDE_CLIENT_ID, STAGING_CALC_CONTEXT_CLIENT_ID
 *   STAGING_RECURSION_LIMIT
 *   CURSOR_API_KEY — для --composer
 *   STAGING_COMPOSER_MODEL, STAGING_COMPOSER_SKIN_DISABLE, STAGING_COMPOSER_SKIN_NODE_ALLOWLIST, STAGING_COMPOSER_STEP_DELAY_MS
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

import { stagingManifestToJson } from "./run-manifest.js";
import { runStagingGraphInvoke } from "./staging-graph-invoke.js";

function printHelp(): void {
  console.log(`staging-graph-cli — один прогон appGraph, манифест в JSON.

Использование:
  npm run staging:graph -- [опции] ["текст запроса"]

Опции:
  --no-trace      только invoke (без graph_steps / llm_call_records)
  --composer      после прогона — Composer 2 по каждому шагу (нужен CURSOR_API_KEY; несовместимо с --no-trace)
  --out <dir>     каталог для staging-runs/<run_id>/manifest.json
  --scenario <id> идентификатор сценария в манифесте
  -h, --help      эта справка

Переменные: STAGING_OUT_DIR, STAGING_QUERY, STAGING_SCENARIO_ID, STAGING_CHAT_ID, …
`);
}

function parseCli(argv: string[]): {
  collectTrace: boolean;
  composerSkin: boolean;
  outDir: string;
  scenarioId: string;
  queryParts: string[];
} {
  let collectTrace = true;
  let composerSkin = false;
  let outDir = process.env.STAGING_OUT_DIR?.trim() || path.join(process.cwd(), "staging-runs");
  let scenarioId = process.env.STAGING_SCENARIO_ID?.trim() || "cli_run";
  const queryParts: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
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

  return { collectTrace, composerSkin, outDir, scenarioId, queryParts };
}

async function main(): Promise<void> {
  const { collectTrace, composerSkin, outDir, scenarioId, queryParts } = parseCli(process.argv);
  const userQuery =
    queryParts.join(" ").trim() ||
    process.env.STAGING_QUERY?.trim() ||
    "Привет, это CLI-прогон стенда (staging-graph-cli). Ответь одним коротким предложением.";

  const chatId = process.env.STAGING_CHAT_ID?.trim() || "staging-cli-000001";
  const sessionId =
    process.env.STAGING_SESSION_ID?.trim() || `staging-cli-session-${Date.now()}`;
  const telegramUserId = process.env.STAGING_TELEGRAM_USER_ID?.trim() || "999001";
  const crmOverride = process.env.STAGING_CRM_OVERRIDE_CLIENT_ID?.trim();
  const calcCtx = process.env.STAGING_CALC_CONTEXT_CLIENT_ID?.trim();
  const recRaw = process.env.STAGING_RECURSION_LIMIT?.trim();
  const recursionLimit = recRaw ? Number.parseInt(recRaw, 10) : 60;
  if (recRaw && (!Number.isFinite(recursionLimit) || recursionLimit < 1)) {
    throw new Error(`Invalid STAGING_RECURSION_LIMIT: ${recRaw}`);
  }

  if (composerSkin && !collectTrace) {
    throw new Error("--composer требует трейс графа (уберите --no-trace)");
  }

  console.error(
    `[staging-graph-cli] scenario=${scenarioId} collectTrace=${collectTrace} composerSkin=${composerSkin} chat=${chatId} session=${sessionId}`
  );

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
    notes: "staging-graph-cli",
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
    `[staging-graph-cli] done run_id=${manifest.run_id} steps=${manifest.graph_steps?.length ?? 0} llm_calls=${manifest.llm_call_records?.length ?? 0} composer_audits=${composerAudits}`
  );
}

main().catch((e) => {
  console.error("[staging-graph-cli] failed:", e);
  process.exit(1);
});
