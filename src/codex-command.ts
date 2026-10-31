/** Shared account-command metadata and operations for terminal front doors. */

import type { OpenAICodexService } from "./service.ts";
import type { OpenAICodexUsage } from "./usage.ts";

export interface CodexCommandNode {
  name: string;
  aliases?: readonly string[];
  description: string;
  descriptions?: Readonly<Partial<Record<"zh" | "en", string>>>;
  tag?: string;
}

export const CODEX_HELP = [
  "Usage: /codex <status|login|logout|usage|config|set>",
  "  /codex status",
  "  /codex login [browser|device]",
  "  /codex logout",
  "  /codex usage",
  "  /codex config",
  "  /codex set <backend-fallback|read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>",
].join("\n");

function node(name: string, en: string, zh: string): CodexCommandNode {
  return { name, description: en, descriptions: { en, zh } };
}

const ACTIONS: readonly CodexCommandNode[] = [
  node("status", "Show the ChatGPT sign-in state", "查看 ChatGPT 登录状态"),
  node("login", "Get a browser URL or device code for ChatGPT sign-in", "获取 ChatGPT 浏览器登录链接或设备码"),
  node("logout", "Remove the dsh Codex credential", "移除 dsh Codex 登录凭据"),
  node("usage", "Show current Codex usage limits", "查看当前 Codex 用量限制"),
  node("config", "Show live Codex settings", "查看 Codex 实时配置"),
  node("set", "Change one live Codex setting", "修改一项 Codex 实时配置"),
];

const SETTINGS: readonly CodexCommandNode[] = [
  node("backend-fallback", "Follow model recovery authorized by OpenAI", "使用 OpenAI 后端授权的模型回退"),
  node("read-image", "Enhance read_image with HTTP(S) input", "为 read_image 增加 HTTP(S) 图片输入"),
  node("imagegen-other-models", "Allow other vision models to call imagegen", "允许其他视觉模型调用 imagegen"),
  node("websocket-context", "Reuse Codex WebSocket response context", "复用 Codex WebSocket 响应上下文"),
  node("native-compaction", "Use Codex V2 Responses compaction", "使用 Codex V2 Responses 压缩"),
];

const BOOLEAN_VALUES: readonly CodexCommandNode[] = [
  node("on", "Enable this setting", "启用此设置"),
  node("off", "Disable this setting", "关闭此设置"),
];

const LOGIN_METHODS: readonly CodexCommandNode[] = [
  node("browser", "Sign in through a browser callback", "通过浏览器回调登录"),
  node("device", "Sign in with a device code", "使用设备码登录"),
];

export function codexSubcommands(path: readonly string[]): readonly CodexCommandNode[] {
  if (path.length === 1 && path[0] === "codex") return ACTIONS;
  if (path.length === 2 && path[0] === "codex" && path[1] === "login") return LOGIN_METHODS;
  if (path.length === 2 && path[0] === "codex" && path[1] === "set") return SETTINGS;
  if (path.length === 3 && path[0] === "codex" && path[1] === "set" &&
      SETTINGS.some(setting => setting.name === path[2])) return BOOLEAN_VALUES;
  return [];
}

export function formatCodexUsage(usage: OpenAICodexUsage): string {
  const lines: string[] = [];
  for (const limit of usage.rateLimits) {
    const name = limit.name ?? limit.id;
    for (const window of limit.windows)
      lines.push(`${name} (${window.windowSeconds}s): ${window.remainingPercent.toFixed(1)}% remaining`);
  }
  if (usage.individualLimit !== undefined)
    lines.push(`Individual limit: ${usage.individualLimit.remainingPercent.toFixed(1)}% remaining (${usage.individualLimit.remaining}/${usage.individualLimit.limit})`);
  if (usage.credits !== undefined)
    lines.push(`Credits: ${usage.credits.unlimited ? "unlimited" : (usage.credits.balance ?? "available")}`);
  return lines.length === 0 ? "OpenAI Codex usage is currently unavailable." : lines.join("\n");
}

function formatTokenCount(tokens: number): string {
  return tokens % 1_000 === 0 ? `${tokens / 1_000}K tokens` : `${tokens} tokens`;
}

function formatProxyUrl(proxyUrl: string): string {
  if (proxyUrl.length === 0) return "environment";
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid";
  }
}

export function formatCodexConfig(service: OpenAICodexService): string {
  const image = service.imagePreferences();
  const responses = service.responsePreferences();
  const contextWindow = service.contextWindowPreferences();
  const catalog = service.modelCatalogSettings();
  const proxy = service.proxyPreferences();
  const fallback = service.modelFallbackPreferences();
  const enabledModels = new Set(catalog.models);
  const models = catalog.availableModels.flatMap(model => [
    "", `model: ${model.name}`, `  id: ${model.id}`,
    `  default-window: ${formatTokenCount(model.contextWindow)}`,
    `  enabled: ${enabledModels.has(model.id) ? "on" : "off"}`,
  ]);
  return [
    `backend-fallback: ${fallback.automaticModelFallback ? "on" : "off"}`,
    `read-image: ${image.modifyReadImage ? "on" : "off"}`,
    `imagegen-other-models: ${image.shareImagegenWithOtherModels ? "on" : "off"}`,
    `imagegen-model: ${image.imageGenerationModel}`,
    `websocket-context: ${responses.useWebSocketContextReuse ? "on" : "off"}`,
    `native-compaction: ${responses.useNativeCompaction ? "on" : "off"}`,
    `context-window: ${contextWindow.contextWindow === null ? "provider-default" : `${contextWindow.contextWindow} tokens`}`,
    `proxy-mode: ${proxy.proxyMode}`,
    `proxy-url: ${formatProxyUrl(proxy.proxyUrl)}`,
    ...models,
  ].join("\n");
}

export async function updateCodexBooleanSetting(
  service: OpenAICodexService,
  key: string,
  enabled: boolean
): Promise<void> {
  switch (key) {
    case "backend-fallback":
      await service.updateModelFallbackPreferences({ automaticModelFallback: enabled });
      return;
    case "read-image":
      await service.updateImagePreferences({ modifyReadImage: enabled });
      return;
    case "imagegen-other-models":
      await service.updateImagePreferences({ shareImagegenWithOtherModels: enabled });
      return;
    case "websocket-context":
      await service.updateResponsePreferences({ useWebSocketContextReuse: enabled });
      return;
    case "native-compaction":
      await service.updateResponsePreferences({ useNativeCompaction: enabled });
      return;
    default:
      throw new Error(`unknown setting ${JSON.stringify(key)}`);
  }
}
