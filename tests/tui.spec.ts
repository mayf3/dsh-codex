import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { OpenAICodexService } from "../src/service.ts";
import * as TuiAdapter from "../src/tui.ts";
import type { OpenAICodexTuiSettingsSection } from "../src/tui-settings.ts";

let context: Context | undefined;

afterEach(async () => {
  await context?.fiber.dispose();
  context = undefined;
});

function fakeService(): OpenAICodexService {
  let imagePreferences = {
    modifyReadImage: true,
    shareImagegenWithOtherModels: true,
    imageGenerationModel: "gpt-image-2" as const,
  };
  let responsePreferences = {
    useWebSocketContextReuse: false,
    useNativeCompaction: false,
  };
  let contextWindowPreferences = {
    contextWindow: null,
  };
  let proxyPreferences = {
    proxyMode: "off" as const,
    proxyUrl: "",
  };
  let modelFallbackPreferences = { automaticModelFallback: false };
  return {
    authStatus: vi.fn(async () => ({
      authenticated: true,
      expiresAt: new Date("2026-08-17T00:00:00Z"),
    })),
    usage: vi.fn(async () => ({
      rateLimits: [
        {
          id: "codex",
          name: "Codex",
          windows: [{ windowSeconds: 18_000, remainingPercent: 62.5 }],
        },
      ],
    })),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    imagePreferences: vi.fn(() => ({ ...imagePreferences })),
    updateImagePreferences: vi.fn(async (patch) => {
      imagePreferences = { ...imagePreferences, ...patch };
      return { ...imagePreferences };
    }),
    responsePreferences: vi.fn(() => ({ ...responsePreferences })),
    modelFallbackPreferences: vi.fn(() => ({ ...modelFallbackPreferences })),
    updateModelFallbackPreferences: vi.fn(async (patch) => {
      modelFallbackPreferences = { ...modelFallbackPreferences, ...patch };
      return { ...modelFallbackPreferences };
    }),
    contextWindowPreferences: vi.fn(() => ({ ...contextWindowPreferences })),
    updateContextWindowPreferences: vi.fn(async (patch) => {
      contextWindowPreferences = { ...contextWindowPreferences, ...patch };
      return { ...contextWindowPreferences };
    }),
    modelCatalogSettings: vi.fn(() => ({
      models: ["gpt-5.6-luna"],
      availableModels: [
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 272_000 },
      ],
    })),
    proxyPreferences: vi.fn(() => ({ ...proxyPreferences })),
    updateProxyPreferences: vi.fn(async (patch) => {
      proxyPreferences = { ...proxyPreferences, ...patch };
      return { ...proxyPreferences };
    }),
    updateResponsePreferences: vi.fn(async (patch) => {
      responsePreferences = { ...responsePreferences, ...patch };
      return { ...responsePreferences };
    }),
  } as unknown as OpenAICodexService;
}

async function command(ctx: Context): Promise<CommandDefinition> {
  const agent = { ctx } as never;
  const definition = ctx.commands.find(agent, "codex");
  if (definition === undefined) throw new Error("/codex was not registered");
  return definition;
}

describe("UI-neutral command with optional dsh-tui completion", () => {
  it("registers the command without requiring dsh-tui", async () => {
    const ctx = new Context();
    context = ctx;
    ctx.provide("openAICodex", fakeService());
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);

    expect(ctx.commands.list({ ctx } as never)).toEqual([
      expect.objectContaining({
        name: "codex",
        description: expect.stringContaining("OpenAI Codex"),
      }),
    ]);
    expect(ctx.get("openAICodexTui")).toBeUndefined();
  });

  it("registers one provider command when dsh-tui is present", async () => {
    const ctx = new Context();
    context = ctx;
    const service = fakeService();
    Object.assign(service, { settingsNamespace: "llm-openai-codex" });
    ctx.provide("openAICodex", service);
    let settingsSection: OpenAICodexTuiSettingsSection | undefined;
    ctx.provide("tuiSettingsSections", {
      register(section: OpenAICodexTuiSettingsSection) {
        settingsSection = section;
        return () => { settingsSection = undefined; };
      },
    });
    let commandTree:
      | {
          descriptions?: Readonly<Partial<Record<"zh" | "en", string>>>;
          children(path: readonly string[]): readonly { name: string }[];
        }
      | undefined;
    ctx.provide("tuiCommandTrees", {
      register(provider: typeof commandTree & { root: string }) {
        commandTree = provider;
        return () => {
          commandTree = undefined;
        };
      },
    });
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const definition = await command(ctx);
    expect(definition.description).toContain("OpenAI Codex");
    if (commandTree === undefined)
      throw new Error("Codex command tree was not registered");
    expect(commandTree.descriptions?.zh).toBe(
      "管理 OpenAI Codex 账号与提供方设置"
    );
    expect(commandTree.children(["codex"]).map((item) => item.name)).toEqual([
      "status",
      "login",
      "logout",
      "usage",
      "config",
      "set",
    ]);
    expect(commandTree.children(["codex"])[0]).toMatchObject({
      descriptions: {
        en: "Show the ChatGPT sign-in state",
        zh: "查看 ChatGPT 登录状态",
      },
    });
    expect(
      commandTree.children(["codex", "set"]).map((item) => item.name)
    ).toEqual([
      "backend-fallback",
      "read-image",
      "imagegen-other-models",
      "websocket-context",
      "native-compaction",
    ]);
    expect(
      commandTree
        .children(["codex", "set", "native-compaction"])
        .map((item) => item.name)
    ).toEqual(["on", "off"]);
    await expect(
      definition.handler({ rawInput: " status" } as never)
    ).resolves.toEqual({
      kind: "success",
      text: "OpenAI Codex is signed in. Access token expires 2026-08-17T00:00:00.000Z; refresh is automatic.",
    });
    await expect(
      definition.handler({ rawInput: " usage" } as never)
    ).resolves.toEqual({
      kind: "success",
      text: "Codex (18000s): 62.5% remaining",
    });
    const config = await definition.handler({ rawInput: " config" } as never);
    expect(config).toMatchObject({
      kind: "success",
      text: expect.stringContaining("read-image: on"),
    });
    expect(config.text).toContain("backend-fallback: off");
    expect(config.text).toContain("imagegen-model: gpt-image-2");
    expect(config.text).toContain(
      [
        "model: GPT-5.6 Luna",
        "  id: gpt-5.6-luna",
        "  default-window: 272K tokens",
        "  enabled: on",
      ].join("\n")
    );
    expect(commandTree.children(["codex", "login"]).map((item) => item.name))
      .toEqual(["browser", "device"]);
    await expect(
      definition.handler({ rawInput: " set native-compaction on" } as never)
    ).resolves.toMatchObject({
      kind: "success",
      text: expect.stringContaining("native-compaction: on"),
    });
    expect(service.updateResponsePreferences).toHaveBeenCalledWith({
      useNativeCompaction: true,
    });
    await expect(
      definition.handler({ rawInput: " set backend-fallback on" } as never)
    ).resolves.toMatchObject({
      kind: "success",
      text: expect.stringContaining("backend-fallback: on"),
    });
    expect(service.updateModelFallbackPreferences).toHaveBeenCalledWith({
      automaticModelFallback: true,
    });
    expect(ctx.get("openAICodexTui")).toEqual({});
    expect(settingsSection?.ns).toBe("llm-openai-codex");
    expect(settingsSection?.fields.map(field => field.path[0])).toEqual([
      "modifyReadImage",
      "shareImagegenWithOtherModels",
      "imageGenerationModel",
      "contextWindow",
      "fastModeDefault",
      "automaticModelFallback",
      "useWebSocketContextReuse",
      "useNativeCompaction",
      "proxyMode",
    ]);
    const contextField = settingsSection?.fields.find(field => field.path[0] === "contextWindow");
    expect(contextField?.parse?.("")).toEqual({ kind: "set", value: null });
    expect(contextField?.parse?.("272000")).toEqual({ kind: "set", value: 272000 });
    expect(contextField?.parse?.("1.5")).toBeUndefined();
    await ctx.fiber.dispose();
    context = undefined;
    expect(settingsSection).toBeUndefined();
  });

  it("exposes a device-code login without opening a browser", async () => {
    const ctx = new Context();
    context = ctx;
    const service = fakeService();
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(service.login).mockImplementation(async (interaction) => {
      expect(await interaction.prompt({
        type: "select", message: "method", options: [{ id: "device_code", label: "Device" }],
      })).toBe("device_code");
      interaction.notify({
        type: "device_code", verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH", expiresInSeconds: 900,
      });
    });
    ctx.provide("openAICodex", service);
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);
    const definition = await command(ctx);
    await expect(definition.handler({ rawInput: " login device" } as never))
      .resolves.toMatchObject({
        kind: "success",
        text: expect.stringContaining("ABCD-EFGH"),
      });
    expect(service.login).toHaveBeenCalledOnce();
  });

  it("returns the browser authorization URL for the user to open", async () => {
    const ctx = new Context();
    context = ctx;
    const service = fakeService();
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(service.login).mockImplementation(async (interaction) => {
      expect(await interaction.prompt({
        type: "select", message: "method", options: [{ id: "browser", label: "Browser" }],
      })).toBe("browser");
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize" });
    });
    ctx.provide("openAICodex", service);
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);
    const definition = await command(ctx);
    await expect(definition.handler({ rawInput: " login" } as never))
      .resolves.toMatchObject({
        kind: "success",
        text: expect.stringContaining("https://auth.openai.com/oauth/authorize"),
      });
  });

  it("shows a credential written after an earlier TUI login error", async () => {
    const ctx = new Context();
    context = ctx;
    const service = fakeService();
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: false });
    vi.mocked(service.login).mockRejectedValue(new Error("authorization failed"));
    ctx.provide("openAICodex", service);
    await ctx.plugin(CommandRuntime);
    await ctx.plugin(TuiAdapter);
    const definition = await command(ctx);
    await expect(definition.handler({ rawInput: " login" } as never))
      .resolves.toMatchObject({ kind: "error" });
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: true });
    await expect(definition.handler({ rawInput: " status" } as never))
      .resolves.toMatchObject({ kind: "success", text: expect.stringContaining("signed in") });
  });
});
