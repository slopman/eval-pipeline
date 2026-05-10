import { HumanMessage } from "@langchain/core/messages";

import { appGraph } from "../agentic_rag/graph.js";
import type { UiLocale } from "../db/chat-ui-locale-persist.js";
import {
  createStagingOnBotStatusHook,
  finalizeStagingManifest,
  newStagingManifest,
  summarizeGraphFinalState,
  type StagingRunManifest,
  type StagingGraphScenarioMeta,
} from "./run-manifest.js";
import { runStagingGraphStreamCollect } from "./staging-graph-stream.js";
import {
  resolveStagingComposerSkinConfig,
  runComposerSkinAuditOnManifest,
} from "./staging-composer-skin.js";

export type ReplyPersonaGraph = "guru" | "colleague" | "advanced" | "beginner";

export type RunStagingGraphOptions = {
  scenarioId: string;
  userQuery: string;
  /** Выделенный chat id для SQLite / контекста (не продовый TG-чат оператора) */
  telegramChatId: string;
  sessionId: string;
  telegramUserId?: string;
  crmOverrideClientId?: string;
  calculationContextClientId?: string;
  uiLocale?: UiLocale;
  replyPersona?: ReplyPersonaGraph;
  botDisplayName?: string;
  recursionLimit?: number;
  notes?: string;
  /**
   * `staging:fixture`: после LLM супервизор принудительно ставит CHART с этими полями → в графе выполняется **chartMaker**
   * (пересчёт + prefetch + паспорт), а не только ответ из comment.
   */
  stagingFixtureChartThroughGraph?: { name: string; date: string; city: string };
  /**
   * Собрать graph_steps, llm_call_records, automated_checks через stream + LLM callbacks.
   * Иначе — обычный invoke (как раньше).
   */
  collectTrace?: boolean;
  /**
   * После прогона — аудит каждого шага через Cursor SDK (Composer), см. staging-composer-skin.ts.
   * Требует `collectTrace: true` и `CURSOR_API_KEY`.
   */
  composerSkin?: boolean;
};

export type RunStagingGraphResult = {
  manifest: StagingRunManifest;
  /** Полный финальный state LangGraph */
  finalState: Record<string, unknown>;
};

function buildScenarioMeta(opts: RunStagingGraphOptions): StagingGraphScenarioMeta {
  return {
    scenario_id: opts.scenarioId,
    staging_chat_id: opts.telegramChatId,
    session_id: opts.sessionId,
    telegram_user_id: opts.telegramUserId,
    ...(opts.crmOverrideClientId?.trim()
      ? { crm_override_client_id: opts.crmOverrideClientId.trim() }
      : {}),
    ...(opts.calculationContextClientId?.trim()
      ? { calculation_context_client_id: opts.calculationContextClientId.trim() }
      : {}),
  };
}

function buildConfigurable(
  opts: RunStagingGraphOptions,
  onBotStatus: ReturnType<typeof createStagingOnBotStatusHook>
): Record<string, unknown> {
  return {
    botDisplayName: opts.botDisplayName ?? "StagingBot",
    onBotStatus,
    telegramChatId: opts.telegramChatId,
    telegramUserId: opts.telegramUserId,
    sessionId: opts.sessionId,
    replyPersona: opts.replyPersona ?? "colleague",
    uiLocale: opts.uiLocale ?? "ru",
    ...(opts.crmOverrideClientId?.trim()
      ? { crmOverrideClientId: opts.crmOverrideClientId.trim() }
      : {}),
    ...(opts.calculationContextClientId?.trim()
      ? { calculationContextClientId: opts.calculationContextClientId.trim() }
      : {}),
    ...(opts.collectTrace ? { stagingCollectTrace: true as const } : {}),
    ...(opts.stagingFixtureChartThroughGraph
      ? { stagingFixtureChartThroughGraph: opts.stagingFixtureChartThroughGraph }
      : {}),
  };
}

/**
 * Один программный вызов графа как у бота, без Telegram API:
 * статусы графа собираются в manifest.telegram_side_effects.
 *
 * При `collectTrace: true` — тот же прогон через `stream` (updates/values) плюс
 * `llm_call_records` из LangChain callbacks.
 */
export async function runStagingGraphInvoke(
  opts: RunStagingGraphOptions
): Promise<RunStagingGraphResult> {
  const meta = buildScenarioMeta(opts);
  const manifest = newStagingManifest(meta);
  if (opts.notes?.trim()) manifest.notes = opts.notes.trim();

  const onBotStatus = createStagingOnBotStatusHook(manifest);
  const configurable = buildConfigurable(opts, onBotStatus);

  let finalState: Record<string, unknown>;

  if (opts.collectTrace) {
    finalState = await runStagingGraphStreamCollect(manifest, {
      userQuery: opts.userQuery,
      sessionId: opts.sessionId,
      recursionLimit: opts.recursionLimit,
      configurable,
    });
  } else {
    finalState = (await appGraph.invoke(
      {
        userQuery: opts.userQuery,
        messages: [new HumanMessage(opts.userQuery)],
        sessionId: opts.sessionId,
      },
      {
        recursionLimit: opts.recursionLimit ?? 60,
        configurable: configurable as Record<string, unknown>,
      }
    )) as Record<string, unknown>;
  }

  finalizeStagingManifest(manifest, summarizeGraphFinalState(finalState));

  if (opts.composerSkin) {
    if (!opts.collectTrace) {
      throw new Error(
        "composerSkin требует collectTrace: true (нужны graph_steps и state_visible_bundle)"
      );
    }
    const cc = resolveStagingComposerSkinConfig();
    if (!cc) {
      throw new Error(
        "composerSkin: нужен CURSOR_API_KEY в окружении; опционально STAGING_COMPOSER_MODEL. Отключить аудит: не передавать composerSkin или STAGING_COMPOSER_SKIN_DISABLE=1"
      );
    }
    await runComposerSkinAuditOnManifest({
      manifest,
      userQuery: opts.userQuery,
      modelId: cc.modelId,
      apiKey: cc.apiKey,
      cwd: cc.cwd,
    });
  }

  return { manifest, finalState };
}
