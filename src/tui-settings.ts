/** Display metadata for dsh-tui's optional SettingsSection service. */

import { OPENAI_CODEX_IMAGE_MODELS } from "./image-model.ts";

interface LocalizedText {
  en: string;
  zh: string;
}

interface TuiSettingsOption {
  value: string;
  label: string;
  descriptions?: LocalizedText;
}

interface TuiSettingsField {
  path: readonly string[];
  label: string;
  descriptions?: LocalizedText;
  hint?: string;
  hintDescriptions?: LocalizedText;
  group?: string;
  kind: "text" | "number" | "boolean" | "select";
  options?: readonly TuiSettingsOption[];
  format?(value: unknown): string;
  parse?(text: string): { kind: "set"; value: unknown } | { kind: "clear" } | undefined;
}

export interface OpenAICodexTuiSettingsSection {
  ns: string;
  title: string;
  descriptions?: LocalizedText;
  groups?: readonly { id: string; title: string; descriptions?: LocalizedText }[];
  fields: readonly TuiSettingsField[];
}

function field(
  path: string,
  kind: TuiSettingsField["kind"],
  en: string,
  zh: string,
  group: string,
  options?: readonly TuiSettingsOption[]
): TuiSettingsField {
  return {
    path: [path],
    kind,
    label: en,
    descriptions: { en, zh },
    group,
    ...(options === undefined ? {} : { options }),
  };
}

/** Settings remains owned by the main plugin's volatile Config namespace. */
export function openAICodexTuiSettingsSection(
  namespace: string
): OpenAICodexTuiSettingsSection {
  return {
    ns: namespace,
    title: "OpenAI Codex",
    descriptions: { en: "OpenAI Codex", zh: "OpenAI Codex" },
    groups: [
      { id: "models", title: "Models and images", descriptions: { en: "Models and images", zh: "模型与图片" } },
      { id: "responses", title: "Responses", descriptions: { en: "Responses", zh: "响应" } },
      { id: "network", title: "Network", descriptions: { en: "Network", zh: "网络" } },
    ],
    fields: [
      field("modifyReadImage", "boolean", "Allow read_image URLs", "增强 read_image URL", "models"),
      field("shareImagegenWithOtherModels", "boolean", "Share imagegen with other models", "允许其他模型使用生图", "models"),
      field("imageGenerationModel", "select", "Image generation model", "生图模型", "models",
        OPENAI_CODEX_IMAGE_MODELS.map(model => ({ value: model.id, label: model.name }))),
      {
        ...field("contextWindow", "number", "Context window override", "上下文窗口覆盖", "models"),
        hint: "Leave blank to use the provider default (tokens).",
        hintDescriptions: { en: "Leave blank to use the provider default (tokens).", zh: "留空时使用提供方默认值（token）。" },
        format: value => typeof value === "number" ? String(value) : "",
        parse: text => {
          const value = text.trim();
          if (value === "") return { kind: "set", value: null };
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) && parsed > 0
            ? { kind: "set", value: parsed }
            : undefined;
        },
      },
      field("fastModeDefault", "boolean", "Fast Mode by default", "默认启用快速模式", "responses"),
      field("automaticModelFallback", "boolean", "Authorized model fallback", "后端授权的模型回退", "responses"),
      field("useWebSocketContextReuse", "boolean", "Reuse WebSocket context", "复用 WebSocket 上下文", "responses"),
      field("useNativeCompaction", "boolean", "Native Codex compaction", "Codex 原生压缩", "responses"),
      {
        ...field("proxyMode", "select", "Proxy scope", "代理范围", "network", [
          { value: "off", label: "Follow dsh", descriptions: { en: "Follow dsh", zh: "跟随 dsh" } },
          { value: "scoped", label: "Codex only", descriptions: { en: "Codex only", zh: "仅 Codex" } },
          { value: "global", label: "All dsh", descriptions: { en: "All dsh", zh: "整个 dsh" } },
        ]),
        hint: "Global affects every dsh plugin. Set the proxy URL in Web Settings or profile Config.",
        hintDescriptions: {
          en: "Global affects every dsh plugin. Set the proxy URL in Web Settings or profile Config.",
          zh: "整个 dsh 模式会影响所有插件；代理 URL 请在 Web 设置页或 profile Config 中配置。",
        },
      },
    ],
  };
}
