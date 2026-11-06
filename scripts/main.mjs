import * as core from "./core.mjs";
import { registerMenus, LogViewer } from "./reports-app.mjs";

const { MODULE_ID } = core;

/**
 * Public API. Available as game.modules.get("usedtp-logger").api and globalThis.UsedtpLogger.
 *   const log = UsedtpLogger.register("my-module", { title: "My Module" });
 *   log.info("text", data); log.warn(...); log.error("text", err, data); log.unclear(key, "text", data);
 *   log.guard("label", async () => { ... });   log.openReport("error" | "unclear", context);
 */
const api = {
  register: core.register,
  get: core.get,
  openReport: core.openReportDialog,
  openViewer: () => new LogViewer().render(true),
  flush: core.flush,
  Logger: core.Logger
};
globalThis.UsedtpLogger = api;

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;

  game.settings.register(MODULE_ID, "consoleLevel", {
    name: "USEDTPLOG.settings.consoleLevel.name",
    hint: "USEDTPLOG.settings.consoleLevel.hint",
    scope: "client",
    config: true,
    type: String,
    choices: { debug: "Debug", info: "Info", warn: "Warnings", error: "Errors" },
    default: "warn"
  });
  game.settings.register(MODULE_ID, "persistInfo", {
    name: "USEDTPLOG.settings.persistInfo.name",
    hint: "USEDTPLOG.settings.persistInfo.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "persistDebug", {
    name: "USEDTPLOG.settings.persistDebug.name",
    hint: "USEDTPLOG.settings.persistDebug.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  registerMenus();
  core.captureUncaught();
  Hooks.callAll("usedtpLogger.ready", api);
});

Hooks.once("ready", () => {
  game.socket?.on(core.CHANNEL, core.onSocket);
  setTimeout(() => core.resendQueued(), 3000);
  Hooks.on("userConnected", (user, connected) => {
    if (connected && user?.isGM) setTimeout(() => core.resendQueued(), 3000);
  });
  globalThis.addEventListener?.("beforeunload", () => { core.flush(); });
});
