# usedtp Logger

One log and one Error/Unclear report system for all usedtp Foundry modules. Foundry VTT v14.

## Install
Manifest URL: `https://github.com/usedtp/usedtp-logger/releases/latest/download/module.json`

Modules that use it list it under `relationships.requires`, so Foundry installs it with them.

## Where logs go
- `Data/usedtp-logs/<module>/YYYY-MM-DD/HHMMSS-nnn-id.json`, written in batches (every 30 s; errors and reports at once).
- A GM's browser writes its own entries.
- A player's browser sends its entries to every GM. One GM writes them: the GM with the lowest user id among GMs running usedtp Logger. A GM whose browser has the logger off is never chosen.
- With no GM running usedtp Logger online, a player's entries wait in the browser and are sent when one connects.
- The viewer shows each entry once, even if two GMs wrote it.
- Remove old logs by hand from the Data folder. Browsers can't delete files.

## Settings
- **Console detail** (per browser): what shows in F12.
- **Log info to file** (default on): normal actions.
- **Log debug to file** (default off): turn on only while chasing a problem.
- **Log viewer** (GM): filter by module and type, mark Fixed or Won't fix, Export JSON.
- **Error / Unclear** (everyone): send a report for any registered module.

## For module code
```js
const log = UsedtpLogger.register("my-module", { title: "My Module" });
log.info("text", data); log.warn("text", data); log.error("text", err, data);
log.unclear("unique-key", "text", data);       // once per session per key
await log.guard("label", async () => { ... }); // logs and shows an error if it throws; the notice says Logged, Sent or Saved on this computer
log.openReport("error" | "unclear", context);
```
Uncaught errors whose stack points into a registered module's folder are logged automatically.

## Tests
`npm test` runs Node tests with a mocked Foundry.
