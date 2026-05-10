/**
 * Staging-only: маршрутизировать вызовы `invokeWithLlmFallback` через Cursor SDK (Composer)
 * вместо Groq/Gemini. Включается при `STAGING_GRAPH_LLM_PROVIDER=composer` и `CURSOR_API_KEY`.
 *
 * Реализован минимальный `BaseChatModel` + `bindTools`, чтобы `withStructuredOutput` (tool-calling
 * pipeline LangChain) продолжал работать: Composer получает инструкцию вернуть один JSON-объект,
 * который маппится в synthetic tool_call с аргументами по имени функции из пайплайна.
 *
 * Ограничения: веб-тулы Groq/Gemini (`browser_search`, `googleSearch`) в этом режиме игнорируются;
 * для финального PRO_LEAD достаточно текстового ответа Composer.
 */
import { BaseChatModel, BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, coerceMessageLikeToMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { BasePromptValueInterface } from "@langchain/core/prompt_values";
import { StringPromptValue } from "@langchain/core/prompt_values";
import type { Runnable } from "@langchain/core/runnables";
import { RunnableLambda } from "@langchain/core/runnables";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";

import { extractCursorPromptText } from "./cursor-sdk-pro-lead.js";
import type { StagingLlmCallRecord } from "../staging/run-manifest.js";

type StagingComposerGraphLlmSink = (record: StagingLlmCallRecord) => void;

let stagingComposerGraphLlmSink: StagingComposerGraphLlmSink | null = null;

/**
 * Регистрирует приёмник записей LLM для стенда: вызовы Composer не проходят через LangChain chat callbacks
 * (pipeline `withStructuredOutput` начинается с RunnableLambda из bindTools).
 */
export function setStagingComposerGraphLlmRecordSink(sink: StagingComposerGraphLlmSink | null): void {
  stagingComposerGraphLlmSink = sink;
}

const DEFAULT_STAGING_COMPOSER_GRAPH_SUFFIX =
  "Если в промпте есть противоречие между расчётными фактами натала (лагна, дома, долготы из блоков данных) и краткими текстовыми выжимками — при заполнении полей JSON опирайся на расчётные факты.";

export function isStagingComposerGraphLlmEnabled(): boolean {
  const v = process.env.STAGING_GRAPH_LLM_PROVIDER?.trim().toLowerCase();
  if (v !== "composer") return false;
  return Boolean(process.env.CURSOR_API_KEY?.trim());
}

export function resolveStagingComposerGraphModelId(): string {
  return (
    process.env.STAGING_COMPOSER_GRAPH_MODEL?.trim() ||
    process.env.STAGING_COMPOSER_MODEL?.trim() ||
    process.env.CURSOR_PRO_LEAD_MODEL?.trim() ||
    "composer-2"
  );
}

function resolveStagingComposerGraphCwd(): string {
  return (
    process.env.STAGING_COMPOSER_GRAPH_CWD?.trim() ||
    process.env.CURSOR_STAGING_COMPOSER_CWD?.trim() ||
    process.env.CURSOR_PRO_LEAD_CWD?.trim() ||
    process.cwd()
  );
}

function stagingComposerGraphSystemSuffix(): string {
  const raw = process.env.STAGING_COMPOSER_GRAPH_SYSTEM_SUFFIX?.trim();
  return raw || DEFAULT_STAGING_COMPOSER_GRAPH_SUFFIX;
}

function baseMessageContentToString(msg: BaseMessage): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text?: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return String(c ?? "");
}

function flattenChatMessages(messages: BaseMessage[]): string {
  return messages.map((m) => `${m._getType()}: ${baseMessageContentToString(m)}`).join("\n\n");
}

function normalizeToChatMessages(input: BaseLanguageModelInput): BaseMessage[] {
  if (typeof input === "string") {
    return new StringPromptValue(input).toChatMessages();
  }
  if (Array.isArray(input)) {
    return input.map((x) => coerceMessageLikeToMessage(x));
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "toChatMessages" in input &&
    typeof (input as BasePromptValueInterface).toChatMessages === "function"
  ) {
    return (input as BasePromptValueInterface).toChatMessages();
  }
  throw new Error("staging composer graph: unsupported prompt value");
}

function extractFirstJsonObject(text: string): Record<string, unknown> {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : t)?.trim() ?? "";
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("staging composer graph: нет JSON-объекта в ответе модели");
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("staging composer graph: корень ответа должен быть объектом");
  }
  return parsed as Record<string, unknown>;
}

async function agentPromptToText(
  body: string,
  trace?: { logLabel: string; recordInStagingManifest: boolean }
): Promise<string> {
  const started_at_iso = new Date().toISOString();
  const run_id = crypto.randomUUID();
  const model_id = resolveStagingComposerGraphModelId();
  try {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.prompt(body, {
      apiKey: process.env.CURSOR_API_KEY!.trim(),
      model: { id: model_id },
      local: { cwd: resolveStagingComposerGraphCwd() },
    });
    const text = extractCursorPromptText(result);
    if (trace?.recordInStagingManifest) {
      const preview = `[${trace.logLabel}] ${text}`;
      const capped = preview.length > 1200 ? `${preview.slice(0, 1200)}…` : preview;
      stagingComposerGraphLlmSink?.({
        run_id,
        recorded_at_iso: new Date().toISOString(),
        started_at_iso,
        model_id,
        completion_preview: capped,
      });
    }
    return text;
  } catch (e) {
    if (trace?.recordInStagingManifest) {
      stagingComposerGraphLlmSink?.({
        run_id,
        recorded_at_iso: new Date().toISOString(),
        started_at_iso,
        model_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
}

function firstOpenAiFunctionTool(
  tools: BindToolsInput[]
): { name: string; description?: string; parameters: Record<string, unknown> } {
  const t = tools[0];
  if (!t || typeof t !== "object") {
    throw new Error("staging composer graph bindTools: пустой список tools");
  }
  const rec = t as Record<string, unknown>;
  if (rec.type === "function" && rec.function && typeof rec.function === "object") {
    const fn = rec.function as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    const parameters =
      fn.parameters && typeof fn.parameters === "object" && fn.parameters !== null
        ? (fn.parameters as Record<string, unknown>)
        : {};
    if (!name) throw new Error("staging composer graph bindTools: у tool нет имени");
    return {
      name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters,
    };
  }
  throw new Error("staging composer graph bindTools: ожидался OpenAI function tool");
}

export type StagingComposerGraphChatModelFields = {
  logLabel: string;
};

/**
 * ChatModel для стенда: plain `_generate` → текст Composer; `bindTools` → synthetic tool_call + JSON args.
 */
export class StagingComposerGraphChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  logLabel: string;

  constructor(fields: StagingComposerGraphChatModelFields) {
    super({ disableStreaming: true });
    this.logLabel = fields.logLabel;
  }

  _llmType(): string {
    return "staging_composer_graph";
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const transcript = flattenChatMessages(messages);
    const body = `Ты — языковая модель внутри стенда LangGraph (staging). Ответь строго по инструкциям в транскрипте сообщений.

### Общие правила стенда
${stagingComposerGraphSystemSuffix()}

(Если в исходном API-вызове фигурировали веб-тулы провайдера — в этом режиме они недоступны; ответь текстом по сути промпта.)

### Транскрипт сообщений (роли LangChain)
${transcript}

### Формат
Верни только итоговый текст ответа (без преамбулы про инструменты), в том виде, который ожидает вызывающий узел: обычно Markdown или краткий текст.`;

    const raw = await agentPromptToText(body);
    const msg = new AIMessageChunk({ content: raw });
    return {
      generations: [{ text: raw, message: msg }],
    };
  }

  bindTools(
    tools: BindToolsInput[]
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
    const fn = firstOpenAiFunctionTool(tools);
    const logLabel = this.logLabel;

    return RunnableLambda.from(
      async (input: BaseLanguageModelInput): Promise<AIMessageChunk> => {
        const messages = normalizeToChatMessages(input);
        const transcript = flattenChatMessages(messages);
        const schemaJson = JSON.stringify(fn.parameters, null, 2);
        const body = `Ты — языковая модель внутри стенда LangGraph (staging). Нужно вернуть АРГУМЕНТЫ ОДНОГО вызова функции как один JSON-объект (не массив).

### Правила стенда
${stagingComposerGraphSystemSuffix()}

### Функция (имя обязательно соблюсти на стороне рантайма уже учтено; тебе нужен только JSON args)
- name: ${fn.name}
${fn.description ? `- description: ${fn.description}` : ""}

### JSON Schema параметров (постарайся заполнить все обязательные поля)
\`\`\`json
${schemaJson}
\`\`\`

### Транскрипт сообщений
${transcript}

### Формат ответа
Верни РОВНО один JSON-объект без Markdown и без комментариев снаружи. Если нужно обернуть — допускается один блок \`\`\`json ... \`\`\`.`;

        let raw = "";
        let args: Record<string, unknown> | undefined;
        let promptBody = body;
        for (let attempt = 0; attempt < 2; attempt++) {
          raw = await agentPromptToText(promptBody, {
            logLabel: `${logLabel}/structured`,
            recordInStagingManifest: true,
          });
          try {
            args = extractFirstJsonObject(raw);
            break;
          } catch (e) {
            if (attempt === 1) throw e;
            const errText = e instanceof Error ? e.message : String(e);
            console.warn(
              `⚠️ [${logLabel}] staging composer graph: JSON parse retry (${errText.slice(0, 120)})`
            );
            promptBody = `${body}\n\n### Предыдущий ответ (невалидный JSON)\n${raw.slice(0, 4000)}`;
          }
        }
        if (!args) {
          throw new Error(`staging composer graph: пустой JSON после Composer (${logLabel})`);
        }

        return new AIMessageChunk({
          content: "",
          tool_calls: [
            {
              id: "staging-composer-graph-tool-1",
              name: fn.name,
              args,
            },
          ],
        });
      }
    ) as Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions>;
  }
}

export function makeStagingComposerGraphChatModel(logLabel: string): StagingComposerGraphChatModel {
  return new StagingComposerGraphChatModel({ logLabel });
}

export async function invokeWithStagingComposerGraphFallback<T>(options: {
  primaryModel: string;
  modelChain: string[];
  temperature: number;
  logLabel: string;
  invoke: (
    llm: BaseChatModel,
    modelName: string,
    signal?: AbortSignal
  ) => Promise<T>;
  rotateOnStructuredOutputFailure?: boolean;
  flashHedge?: boolean;
  maxCompletionTokens?: number;
}): Promise<T> {
  const modelId = resolveStagingComposerGraphModelId();
  void options.primaryModel;
  void options.modelChain;
  void options.temperature;
  void options.rotateOnStructuredOutputFailure;
  void options.flashHedge;
  void options.maxCompletionTokens;

  const llm = makeStagingComposerGraphChatModel(options.logLabel);
  const controller = new AbortController();
  const timeoutSignal = AbortSignal.timeout(130000);
  const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

  try {
    console.log(`📡 [${options.logLabel}] Staging Composer graph LLM model=${modelId}`);
    const result = await options.invoke(llm, modelId, combinedSignal);
    controller.abort();
    return result;
  } catch (e) {
    controller.abort();
    throw e;
  }
}
