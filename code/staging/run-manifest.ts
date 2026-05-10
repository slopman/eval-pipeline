/**
 * Артефакт автономного прогона стенда (см. research/STAGING_COMPOSER_SKINS_PIPELINE_QA_2026-05-08.md).
 * Первая версия: JSON-манифест + лог «что ушло бы в TG» через onBotStatus.
 */

export type TelegramSideEffectKind = "bot_status";

export interface TelegramSideEffectRecord {
  kind: TelegramSideEffectKind;
  /** Строка, переданная в onBotStatus из графа (может содержать префиксы ✨ и т.д.) */
  line: string;
  recorded_at_iso: string;
  /** На стенде реальной отправки в Telegram API нет */
  would_deliver_to_telegram: false;
}

export interface StagingGraphScenarioMeta {
  scenario_id: string;
  staging_chat_id: string;
  session_id: string;
  telegram_user_id?: string;
  /** Явный CRM-клиент для configurable (строка как в боте) */
  crm_override_client_id?: string;
  calculation_context_client_id?: string;
}

/** Краткое резюме финального state без полного дампа LangGraph */
export interface StagingGraphOutcomeSummary {
  next_action?: string;
  draft_chars: number;
  leader_comment_chars: number;
  client_geo_fingerprint?: string;
}

/** Шаг графа из streamMode "updates" (имя узла → частичное обновление state). */
export interface StagingGraphStepRecord {
  step_index: number;
  recorded_at_iso: string;
  node_ids: string[];
  /** Сжатый JSON-узел обновления (без сырых огромных полей где возможно). */
  update_visible: Record<string, unknown>;
  /** LangGraph помечает повтор из кэша узла */
  from_cache?: boolean;
  /**
   * Срез RagState после завершения superstep (следующий chunk `"values"` после этого update).
   * Аналог «node_visible_bundle» для машины: что видно в конвейере после шага.
   */
  state_visible_bundle?: Record<string, unknown>;
  /** Аудит Cursor Composer по шагу (режим стенда); заполняется при composerSkin. */
  composer_skin_notes?: string;
  composer_skin_recorded_at_iso?: string;
  composer_skin_error?: string;
}

/** Один вызов chat/LLM внутри графа: LangChain callbacks и/или явная запись для staging Composer (structured pipeline). */
export interface StagingLlmCallRecord {
  run_id: string;
  recorded_at_iso: string;
  started_at_iso?: string;
  model_id?: string;
  token_usage?: Record<string, number>;
  /** Укороченный текст ответа для отчёта без второго LLM */
  completion_preview?: string;
  error?: string;
}

export interface StagingAutomatedCheckRecord {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface StagingRunManifest {
  schema_version: 1;
  run_id: string;
  started_at_iso: string;
  finished_at_iso?: string;
  meta: StagingGraphScenarioMeta;
  telegram_side_effects: TelegramSideEffectRecord[];
  outcome?: StagingGraphOutcomeSummary;
  /** Человеческая пометка прогона */
  notes?: string;
  /**
   * Трассировка superstep'ов (stream "updates"). Заполняется при collectTrace.
   */
  graph_steps?: StagingGraphStepRecord[];
  /**
   * Вызовы LLM внутри прогона. Заполняется при collectTrace.
   */
  llm_call_records?: StagingLlmCallRecord[];
  /**
   * Дешёвые проверки по финальному state. Заполняется при collectTrace.
   */
  automated_checks?: StagingAutomatedCheckRecord[];
  /**
   * Первый полный снимок RagState из stream `"values"` (если пришёл до первого update).
   */
  initial_state_visible_bundle?: Record<string, unknown>;
  /**
   * Финальный снимок RagState (последний `"values"`), дублирует смысл последнего шага для быстрого доступа.
   */
  final_state_visible_bundle?: Record<string, unknown>;
}

export function newStagingManifest(meta: StagingGraphScenarioMeta): StagingRunManifest {
  return {
    schema_version: 1,
    run_id: crypto.randomUUID(),
    started_at_iso: new Date().toISOString(),
    meta,
    telegram_side_effects: [],
  };
}

/** Колбэк для configurable.onBotStatus — только логирует, в Telegram не шлёт */
export function createStagingOnBotStatusHook(manifest: StagingRunManifest) {
  return async (line: string): Promise<void> => {
    manifest.telegram_side_effects.push({
      kind: "bot_status",
      line,
      recorded_at_iso: new Date().toISOString(),
      would_deliver_to_telegram: false,
    });
  };
}

export function finalizeStagingManifest(
  manifest: StagingRunManifest,
  outcome?: StagingGraphOutcomeSummary
): void {
  manifest.finished_at_iso = new Date().toISOString();
  if (outcome) manifest.outcome = outcome;
}

export function summarizeGraphFinalState(state: Record<string, unknown>): StagingGraphOutcomeSummary {
  const draft = typeof state.draft === "string" ? state.draft : "";
  const leaderComment = typeof state.leaderComment === "string" ? state.leaderComment : "";
  const fp =
    typeof state.clientGeoFingerprint === "string" ? state.clientGeoFingerprint : undefined;
  const na = typeof state.nextAction === "string" ? state.nextAction : undefined;
  return {
    next_action: na,
    draft_chars: draft.length,
    leader_comment_chars: leaderComment.length,
    client_geo_fingerprint: fp?.trim() || undefined,
  };
}

export function stagingManifestToJson(manifest: StagingRunManifest): string {
  return JSON.stringify(manifest, null, 2);
}
