/** Optional dsh-tui front-door adapter for account and live preference commands. */

import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import type { OpenAICodexService } from "./service.ts";
import {
  CODEX_HELP,
  codexSubcommands,
  formatCodexConfig,
  formatCodexUsage,
  updateCodexBooleanSetting,
} from "./codex-command.ts";
import type { CodexCommandNode } from "./codex-command.ts";
import { openAICodexTuiSettingsSection } from "./tui-settings.ts";
import type { OpenAICodexTuiSettingsSection } from "./tui-settings.ts";

interface TuiMarkerRuntime {}

interface TuiCommandTreeRuntime {
  register(provider: {
    root: string;
    descriptions?: Readonly<Partial<Record<"zh" | "en", string>>>;
    children(canonicalPath: readonly string[]): readonly CodexCommandNode[];
  }): () => void;
}

interface TuiSettingsSectionsRuntime {
  register(section: OpenAICodexTuiSettingsSection): () => void;
}

interface CommandContext extends Context {
  openAICodex: OpenAICodexService;
  commands: Context["commands"];
}

interface TuiContext extends Context {
  tuiCommandTrees: TuiCommandTreeRuntime;
  tuiSettingsSections: TuiSettingsSectionsRuntime;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Empty marker published while the Codex terminal adapter is active. */
    openAICodexTui: object;
  }
}

export const name = "dsh-codex-tui";
export const inject = ["openAICodex"];

function success(text: string): CommandResult {
  return { kind: "success", text };
}

function failure(text: string): CommandResult {
  return { kind: "error", text };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[redacted token]"
    )
    .replace(
      /(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu,
      "$1[redacted]"
    )
    .slice(0, 1000);
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal;
  if (signal === undefined) return new Promise<string>(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

type LoginState =
  | { status: "idle" }
  | { status: "signing-in" }
  | { status: "error"; message: string };

/** Own the browser challenge while the command returns control to the TUI immediately. */
class TuiLoginController {
  private state: LoginState = { status: "idle" };
  private operation: Promise<void> | undefined;
  private cancellation: AbortController | undefined;
  private method: "browser" | "device_code" | undefined;
  private challenge: Promise<string> | undefined;
  private resolveChallenge: ((message: string) => void) | undefined;
  private rejectChallenge: ((error: unknown) => void) | undefined;

  constructor(private readonly service: OpenAICodexService) {}

  async start(method: "browser" | "device_code" = "browser"): Promise<string> {
    const stored = await this.service.authStatus();
    if (stored.authenticated) return "OpenAI Codex is already signed in.";
    if (this.operation === undefined) this.begin(method);
    else if (this.method !== method)
      throw new Error("Another OpenAI Codex login method is already in progress");
    const challenge = this.challenge;
    if (challenge === undefined)
      throw new Error(
        "OpenAI Codex sign-in did not create an authorization challenge"
      );
    return await challenge;
  }

  status(): LoginState {
    return this.state;
  }

  async logout(): Promise<void> {
    this.cancellation?.abort(new Error("OpenAI Codex sign-in cancelled"));
    await this.operation?.catch(() => undefined);
    await this.service.logout();
    this.state = { status: "idle" };
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error("OpenAI Codex TUI adapter disposed"));
    await this.operation?.catch(() => undefined);
  }

  private begin(method: "browser" | "device_code"): void {
    const cancellation = new AbortController();
    this.cancellation = cancellation;
    this.method = method;
    this.state = { status: "signing-in" };
    this.challenge = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.operation = this.service
      .login({
        signal: cancellation.signal,
        prompt: (prompt) =>
          prompt.type === "select"
            ? Promise.resolve(method)
            : waitForPromptAbort(prompt),
        notify: (event) => {
          this.onEvent(event);
        },
      })
      .then(
        () => {
          this.state = { status: "idle" };
        },
        (error: unknown) => {
          const message = safeMessage(error);
          this.state = { status: "error", message };
          this.rejectChallenge?.(error);
        }
      )
      .finally(() => {
        this.operation = undefined;
        this.cancellation = undefined;
        this.method = undefined;
        this.resolveChallenge = undefined;
        this.rejectChallenge = undefined;
      });
  }

  private onEvent(event: AuthEvent): void {
    if (event.type === "device_code") {
      try {
        const uri = new URL(event.verificationUri);
        if (uri.protocol !== "https:" || event.userCode.trim() === "")
          throw new Error("OpenAI returned an invalid device authorization challenge");
        this.resolveChallenge?.(`Open ${uri.href}\nEnter code: ${event.userCode}\nUse /codex status after approval.`);
      } catch (error: unknown) {
        this.cancellation?.abort(error);
        this.rejectChallenge?.(error);
      }
      return;
    }
    if (event.type !== "auth_url") return;
    try {
      const url = new URL(event.url);
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
        throw new Error("OpenAI returned an invalid authorization URL");
      this.resolveChallenge?.(`Open this ChatGPT authorization page: ${url.href}\nUse /codex status after approval.`);
    } catch (error: unknown) {
      this.cancellation?.abort(error);
      this.rejectChallenge?.(error);
    }
  }
}

function formatExpiry(expiresAt: Date | undefined): string {
  return expiresAt === undefined || Number.isNaN(expiresAt.valueOf())
    ? ""
    : ` Access token expires ${expiresAt.toISOString()}; refresh is automatic.`;
}


/** Register executable commands independently from any concrete UI frontend. */
export function apply(ctx: Context): void {
  ctx.inject(["commands"], registerCodexCommand);
  ctx.inject(["tuiCommandTrees"], registerTuiCommandTree);
  ctx.inject(["tuiSettingsSections"], registerTuiSettingsSection);
}

function registerCodexCommand(ctx: Context): void {
  const commandCtx = ctx as CommandContext;
  const service = commandCtx.openAICodex;
  const login = new TuiLoginController(service);
  const disposeCommand = commandCtx.commands.register({
    name: "codex",
    description: "Manage the OpenAI Codex account and provider settings",
    input: { hint: "subcommand" },
    async handler({ rawInput }) {
      const parts = rawInput.trim().split(/\s+/u).filter(Boolean);
      const action = parts[0] ?? "status";
      try {
        switch (action) {
          case "status": {
            const state = login.status();
            const status = await service.authStatus();
            if (status.authenticated)
              return success(
                `OpenAI Codex is signed in.${formatExpiry(status.expiresAt)}`
              );
            if (state.status === "signing-in")
              return success(
                "OpenAI Codex sign-in is waiting for approval."
              );
            if (state.status === "error")
              return failure(`OpenAI Codex sign-in failed: ${state.message}`);
            return failure("OpenAI Codex is signed out. Run /codex login.");
          }
          case "login":
            if (parts.length > 2 || (parts[1] !== undefined && parts[1] !== "browser" && parts[1] !== "device"))
              return failure(CODEX_HELP);
            return success(await login.start(parts[1] === "device" ? "device_code" : "browser"));
          case "logout":
            if (parts.length !== 1) return failure(CODEX_HELP);
            await login.logout();
            return success("OpenAI Codex is signed out.");
          case "usage":
            if (parts.length !== 1) return failure(CODEX_HELP);
            return success(formatCodexUsage(await service.usage()));
          case "config":
            if (parts.length !== 1) return failure(CODEX_HELP);
            return success(formatCodexConfig(service));
          case "set": {
            if (parts.length !== 3 || (parts[2] !== "on" && parts[2] !== "off"))
              return failure(CODEX_HELP);
            await updateCodexBooleanSetting(service, parts[1] as string, parts[2] === "on");
            return success(formatCodexConfig(service));
          }
          default:
            return failure(CODEX_HELP);
        }
      } catch (error: unknown) {
        return failure(safeMessage(error));
      }
    },
  });
  ctx.effect(
    () => async () => {
      disposeCommand();
      await login.dispose();
    },
    "OpenAI Codex command adapter"
  );
}

function registerTuiCommandTree(ctx: Context): void {
  const tui = ctx as TuiContext;
  const disposeTree = tui.tuiCommandTrees.register({
    root: "codex",
    descriptions: {
      en: "Manage the OpenAI Codex account and provider settings",
      zh: "管理 OpenAI Codex 账号与提供方设置",
    },
    children: codexSubcommands,
  });
  ctx.provide("openAICodexTui", {} as TuiMarkerRuntime);
  ctx.effect(() => disposeTree, "OpenAI Codex TUI completion adapter");
}

function registerTuiSettingsSection(ctx: Context): void {
  const tui = ctx as TuiContext;
  const service = (ctx as CommandContext).openAICodex;
  if (!/^[a-z][a-z0-9_-]*$/u.test(service.settingsNamespace)) {
    ctx.logger.warn(
      `OpenAI Codex TUI settings unavailable: Loader ID ${JSON.stringify(service.settingsNamespace)} is not a TUI settings namespace`
    );
    return;
  }
  const dispose = tui.tuiSettingsSections.register(
    openAICodexTuiSettingsSection(service.settingsNamespace)
  );
  ctx.effect(() => dispose, "OpenAI Codex TUI settings section");
}

export default apply;
