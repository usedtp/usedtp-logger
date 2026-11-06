# Moving a usedtp module to usedtp-logger

Read this before changing a module. It is the full spec for the switch.

## What moves, what stays

**Moves to usedtp-logger (diagnostics):**
- console errors and warnings
- try/catch wrappers that log failures
- global error capture
- Error/Unclear reports, their socket delivery, offline queue and acknowledgements
- the GM report viewer
- debug on/off settings

**Stays in the module (data):**
- data the module records on purpose, as part of what it does: roll-lessons' roll log (the dataset) and its files, flight-plan's movement log.
- Keep its own writer and folder. If that writer fails, send the failure to usedtp-logger.

**Old log files** stay where they are. The usedtp-logger viewer reads only `Data/usedtp-logs/`. Nothing is migrated.

## 1. module.json

Add under `relationships`:

```json
"requires": [
  {
    "id": "usedtp-logger",
    "type": "module",
    "manifest": "https://github.com/usedtp/usedtp-logger/releases/latest/download/module.json",
    "compatibility": { "minimum": "1.0.0" }
  }
]
```

- Keep `"socket": true` only if the module still uses its own socket for something other than reports.
- Bump the minor version, e.g. 1.5.1 to 1.6.0.

## 2. Add the adapter: `scripts/diag.mjs`

Every file imports from this one file and nothing else talks to the logger. If usedtp-logger is missing, the module still runs and logs to the console.

```js
const MODULE_ID = "<module-id>";
const TITLE = "<Module Title>";

const fallback = {
  debug: (m, d) => console.debug(`${MODULE_ID} | ${m}`, d ?? ""),
  info: (m, d) => console.log(`${MODULE_ID} | ${m}`, d ?? ""),
  warn: (m, d) => console.warn(`${MODULE_ID} | ${m}`, d ?? ""),
  error: (m, e, d) => console.error(`${MODULE_ID} | ${m}`, e, d ?? ""),
  unclear: (k, m, d) => console.warn(`${MODULE_ID} | unclear: ${m}`, d ?? ""),
  report: () => { ui.notifications?.warn("Install usedtp Logger to send reports."); return Promise.resolve("queued"); },
  async guard(label, fn) {
    try { return await fn(); } catch (err) { console.error(`${MODULE_ID} | ${label} failed`, err); return undefined; }
  },
  openReport: () => ui.notifications?.warn("Install usedtp Logger to send reports.")
};

let logger = null;

/** The module's logger. Call it at use time (log().warn(...)), never store the result at import time. */
export function log() {
  if (logger) return logger;
  const api = game.modules?.get("usedtp-logger")?.api ?? globalThis.UsedtpLogger;
  if (api?.register) logger = api.register(MODULE_ID, { title: TITLE });
  return logger ?? fallback;
}
```

Call `log()` once in the module's `ready` hook (e.g. `log().info("ready")`) so the module shows up in the Error/Unclear dialog straight away.

## 3. API

| Call | Writes to file | Use for |
|---|---|---|
| `log().debug(msg, data)` | only if "Log debug to file" is on | step-by-step tracing |
| `log().info(msg, data)` | if "Log info to file" is on (default on) | normal actions worth a trail |
| `log().warn(msg, data)` | always | something odd that was handled |
| `log().error(msg, err, data)` | always, at once | anything caught in a catch |
| `log().unclear(key, msg, data)` | always, once per key per session | the module could not decide or explain something |
| `log().report("error" \| "unclear", { comment, context })` | always, at once | a person's report from the module's own UI. Returns `"logged"`, `"sent"` or `"queued"` |
| `await log().guard(label, async fn, data)` | on throw | wraps a handler: logs, shows "X failed", returns undefined |
| `log().openReport(category, context)` | | opens the shared Error/Unclear dialog |

Every entry automatically carries:
- user, GM flag, scene, time
- Foundry, system, module and logger versions

**`data` and `context` rules:**
- Plain objects only.
- Documents are reduced to `{document, uuid, name}`.
- Errors are reduced to `{name, message, stack}`.
- Anything over 8 KB is cut.
- Put `messageId` in `data`/`context` when the entry is about a chat message. The viewer then shows a "Show in chat" button.

Uncaught errors whose stack contains `modules/<module-id>/` are logged automatically once the module has called `log()`.

## 4. Replace old patterns

| Old | New |
|---|---|
| `console.error(\`${MOD} \| x\`, err)` | `log().error("x", err)` |
| `console.warn(...)` | `log().warn(...)` |
| `console.log` / debug-gated console output | `log().debug(...)` or `log().info(...)` |
| own `safe(where, fn, fallback)` / `fail(where, err, ctx)` | `log().guard(where, fn)` / `log().error(where, err, ctx)`. Keep a fallback return value where the caller needs one: `(await log().guard(...)) ?? fallback` |
| own `captureGlobalErrors()` | delete it |
| own debug setting (e.g. `debug`) | delete it, plus every read of it. Console detail is now set in usedtp Logger settings |
| own report socket actions, ack, localStorage queue, `resendQueued`, `userConnected` resend | delete them |
| own report dialog with module-specific fields (e.g. rows to tick) | keep the dialog, replace its send step with `log().report(category, { comment, context })`, and show `ui.notifications.info` for the outcome |
| simple report button with no module-specific fields | `log().openReport(category, context)` |
| own reports viewer app and its settings menu | delete them. Optionally keep a menu button that calls `game.modules.get("usedtp-logger").api.openViewer()` |
| own report-status file and status marking | delete them. The viewer marks Fixed / Won't fix |

## 5. Checklist

1. Add `requires` to module.json. Bump the version. Add a CHANGELOG entry: "Diagnostics and reports now go through usedtp Logger."
2. Add `scripts/diag.mjs`. Replace every old call with it.
3. Delete what is listed in section 4. Delete lang keys that are no longer used.
4. `grep -rn "console\." scripts` should only find lines in `diag.mjs`.
5. Run the module's tests, then `node --check` on every script.
6. In Foundry:
   - Turn on the module. It should list usedtp Logger as required.
   - Make the module log an error: GM Settings > usedtp Logger > Open logs should show it under the module's name.
   - As a player with no GM online, send a report. Log a GM in: the report should arrive.
7. Release: zip with module.json at the root. Upload `module.json` and `module.zip` to the GitHub release.
