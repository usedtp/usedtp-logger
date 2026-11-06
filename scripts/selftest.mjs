import { MODULE_ID, get as getLogger } from "./core.mjs";

/*
 * usedtp self-test: live tests that run inside Foundry, so a module update is checked without anyone at the keyboard.
 *
 * A module registers one suite:
 *   UsedtpLogger.selfTest.register("my-module", async t => {
 *     const scene = await t.scene();
 *     await t.step("does the thing", async () => { t.ok(condition, "what should be true"); });
 *   });
 *
 * The active GM's browser runs each suite once per module version, shortly after loading the world. It works in a
 * hidden sandbox (scene, actors, combat, chat cards) that it removes afterwards. Results go to usedtp Logger under
 * the module's name (failures as errors) and a summary is whispered to the GM.
 */

const suites = new Map();
const AUTO_DELAY_MS = 8000;
const LOCK_MS = 700;
const STEP_TIMEOUT_MS = 30000;
const FOLDER = "usedtp self-test";
const CLIENT = Math.random().toString(36).slice(2, 10);
let running = false;

const setting = (key, fallback) => { try { return game.settings.get(MODULE_ID, key); } catch (err) { return fallback; } };
const wait = ms => new Promise(r => setTimeout(r, ms));

export function registerSettings() {
  game.settings.register(MODULE_ID, "selfTestAuto", {
    name: "USEDTPLOG.selfTest.auto.name", hint: "USEDTPLOG.selfTest.auto.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "selfTestState", { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "selfTestLock", { scope: "world", config: false, type: Object, default: {} });
}

/** Register a module's live test suite. */
export function register(moduleId, suite, { title } = {}) {
  if (typeof suite !== "function") throw new Error(`${moduleId}: self-test suite must be a function`);
  suites.set(moduleId, { suite, title: title ?? game.modules?.get(moduleId)?.title ?? moduleId });
}

export const registeredSuites = () => [...suites.keys()];

class AssertionError extends Error {}

/** Everything a suite gets: steps, checks, and a sandbox it does not have to clean up. */
export class TestContext {
  constructor(moduleId) {
    this.moduleId = moduleId;
    this.steps = [];
    this.skipped = null;
    this.created = [];
    this.messages = new Set();
    this.restore = [];
  }

  /* checks */
  ok(condition, message) { if (!condition) throw new AssertionError(message ?? "expected true"); }
  equal(actual, expected, message) {
    if (actual !== expected) throw new AssertionError(`${message ?? "values differ"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  skip(reason) { this.skipped = String(reason ?? "skipped"); }

  /** Poll until fn returns something truthy. */
  async waitFor(fn, { timeout = 5000, interval = 100, message = "condition" } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await wait(interval);
    }
    throw new AssertionError(`timed out waiting for ${message}`);
  }

  /** One named check. A failure is recorded and the suite carries on. */
  async step(name, fn) {
    const start = Date.now();
    try {
      await Promise.race([fn(), wait(STEP_TIMEOUT_MS).then(() => { throw new AssertionError("step timed out"); })]);
      this.steps.push({ name, pass: true, ms: Date.now() - start });
    } catch (err) {
      this.steps.push({ name, pass: false, ms: Date.now() - start, error: err?.message ?? String(err), stack: err?.stack });
    }
  }

  /* sandbox */
  track(doc) { if (doc) this.created.push(doc); return doc; }

  async folder(type) {
    const existing = game.folders.find(f => f.type === type && f.name === FOLDER);
    if (existing) return existing;
    return this.track(await Folder.create({ name: FOLDER, type }));
  }

  /** A hidden scene, viewed only by this GM browser while the suite runs. */
  async scene(data = {}) {
    const folder = await this.folder("Scene");
    const scene = this.track(await Scene.create({
      name: `${FOLDER}: ${this.moduleId}`, folder: folder.id, navigation: false,
      width: 1400, height: 1000, padding: 0, grid: { size: 100 }, ownership: { default: 0 }, ...data
    }));
    const previous = game.scenes.viewed;
    if (previous && previous.id !== scene.id) this.restore.push(() => previous.view());
    await scene.view();
    await this.waitFor(() => canvas?.ready && canvas.scene?.id === scene.id, { timeout: 15000, message: "sandbox scene" });
    this.sceneDoc = scene;
    return scene;
  }

  async actor(data) {
    const folder = await this.folder("Actor");
    return this.track(await Actor.create({ ownership: { default: 0 }, ...data, folder: folder.id }));
  }

  /** Copy items by name from a compendium onto an actor. */
  async items(actor, packId, names) {
    const pack = game.packs.get(packId);
    if (!pack) throw new AssertionError(`compendium ${packId} not found`);
    const index = await pack.getIndex();
    const data = [];
    for (const name of [].concat(names)) {
      const entry = index.find(e => e.name === name);
      if (!entry) throw new AssertionError(`${name} not in ${packId}`);
      data.push((await pack.getDocument(entry._id)).toObject());
    }
    return actor.createEmbeddedDocuments("Item", data);
  }

  /** Place a token for an actor on the sandbox scene and wait for it to be drawn. */
  async token(actor, { x = 100, y = 100 } = {}) {
    const scene = this.sceneDoc;
    if (!scene) throw new AssertionError("call t.scene() first");
    const data = (await actor.getTokenDocument({ x, y })).toObject();
    const [doc] = await scene.createEmbeddedDocuments("Token", [data]);
    await this.waitFor(() => doc.object, { message: `token for ${actor.name}` });
    return doc;
  }

  /** Start a combat on the sandbox scene. Combatants act in the order given. */
  async combat(tokens) {
    const scene = this.sceneDoc;
    const combat = this.track(await Combat.create({ scene: scene.id, active: true }));
    await combat.createEmbeddedDocuments("Combatant", tokens.map((t, i) => ({
      tokenId: t.id, sceneId: scene.id, actorId: t.actorId, initiative: 100 - i
    })));
    await combat.startCombat();
    return combat;
  }

  /** Target exactly this token, as a player would. */
  target(tokenDoc) {
    for (const t of [...game.user.targets]) t.setTarget(false, { releaseOthers: false });
    tokenDoc.object.setTarget(true, { releaseOthers: true });
  }

  /** Make every die land on the same value (0 to 1). 0.53 gives an 11 on a d20. Undone after the suite. */
  fixDice(u = 0.53) {
    const original = CONFIG.Dice.randomUniform;
    CONFIG.Dice.randomUniform = () => u;
    this.restore.push(() => { CONFIG.Dice.randomUniform = original; });
  }

  /** Remove everything the suite made, newest first. */
  async cleanup() {
    for (const fn of this.restore.reverse()) { try { await fn(); } catch (err) { /* best effort */ } }
    for (const id of this.messages) { try { await game.messages.get(id)?.delete(); } catch (err) { /* already gone */ } }
    for (const doc of this.created.reverse()) {
      try { if (doc.collection?.has?.(doc.id) ?? true) await doc.delete(); } catch (err) { /* already gone */ }
    }
  }
}

/** Run one suite now. Returns its summary. */
export async function runSuite(moduleId) {
  const entry = suites.get(moduleId);
  if (!entry) throw new Error(`no self-test registered for ${moduleId}`);
  const log = getLogger(moduleId);
  const version = game.modules?.get(moduleId)?.version ?? "?";
  const t = new TestContext(moduleId);
  // Test cards go to the GM only. v14 may call the setting messageMode; older builds rollMode.
  const modeKey = ["messageMode", "rollMode"].find(k => game.settings.settings?.has?.(`core.${k}`));
  const rollMode = modeKey ? game.settings.get("core", modeKey) : null;
  const hook = Hooks.on("createChatMessage", m => { if (m.author?.id === game.user.id) t.messages.add(m.id); });
  try {
    // v14 messageMode uses "gm"; the older rollMode used "gmroll".
    if (modeKey) await game.settings.set("core", modeKey, modeKey === "messageMode" ? "gm" : "gmroll");
    await entry.suite(t);
  } catch (err) {
    t.steps.push({ name: "suite setup", pass: false, error: err?.message ?? String(err), stack: err?.stack });
  } finally {
    Hooks.off("createChatMessage", hook);
    await t.cleanup();
    if (modeKey) { try { await game.settings.set("core", modeKey, rollMode); } catch (err) { /* ignore */ } }
  }
  const failed = t.steps.filter(s => !s.pass);
  const summary = { moduleId, title: entry.title, version, at: new Date().toISOString(), passed: t.steps.length - failed.length, failed: failed.length, skipped: t.skipped, steps: t.steps.map(({ stack, ...s }) => s) };
  for (const s of failed) await log.error(`self-test failed: ${s.name}`, new Error(s.error), { version, step: s.name });
  await log.info(`self-test ${t.skipped ? "skipped" : failed.length ? "failed" : "passed"}`, summary);
  return summary;
}

/** Run every suite whose module version has not been tested yet (or all, with force). */
export async function runPending({ force = false } = {}) {
  if (running || !game.user?.isGM) return [];
  const state = foundry.utils.deepClone(setting("selfTestState", {}) ?? {});
  const pending = [...suites.keys()].filter(id => force || state[id]?.version !== game.modules?.get(id)?.version);
  if (!pending.length) return [];
  if (!(await claimRun())) return [];
  running = true;
  const results = [];
  try {
    ui.notifications?.info(game.i18n.format("USEDTPLOG.selfTest.running", { count: pending.length }));
    for (const id of pending) {
      const r = await runSuite(id);
      results.push(r);
      // A skipped suite is not marked as tested, so it runs again on the next load.
      if (!r.skipped) {
        state[id] = { version: r.version, at: r.at, passed: r.passed, failed: r.failed };
        await game.settings.set(MODULE_ID, "selfTestState", state);
      }
    }
    await whisperSummary(results);
  } finally {
    running = false;
  }
  return results;
}

/** Only one browser runs the suites, even with two GM tabs open. */
async function claimRun() {
  const lock = setting("selfTestLock", {}) ?? {};
  if (lock.client && lock.client !== CLIENT && Date.now() - (lock.at ?? 0) < 10 * 60 * 1000) return false;
  await game.settings.set(MODULE_ID, "selfTestLock", { client: CLIENT, at: Date.now() });
  await wait(LOCK_MS);
  return (setting("selfTestLock", {}) ?? {}).client === CLIENT;
}

async function whisperSummary(results) {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  const rows = results.map(r => {
    const status = r.skipped ? `skipped (${esc(r.skipped)})` : r.failed ? `<b>${r.failed} failed</b>, ${r.passed} passed` : `${r.passed} passed`;
    const fails = r.steps.filter(s => !s.pass).map(s => `<li>${esc(s.name)}: ${esc(s.error)}</li>`).join("");
    return `<li>${esc(r.title)} ${esc(r.version)}: ${status}${fails ? `<ul>${fails}</ul>` : ""}</li>`;
  }).join("");
  await ChatMessage.implementation.create({
    content: `<b>usedtp self-test</b><ul>${rows}</ul>`,
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    speaker: { alias: "usedtp self-test" }
  });
  const anyFailed = results.some(r => r.failed);
  ui.notifications?.[anyFailed ? "error" : "info"](game.i18n.localize(anyFailed ? "USEDTPLOG.selfTest.someFailed" : "USEDTPLOG.selfTest.allPassed"));
}

/** Ready hook: run pending suites once modules have registered. */
export function scheduleAutoRun() {
  if (!game.user?.isActiveGM || !setting("selfTestAuto", true)) return;
  setTimeout(() => runPending().catch(err => getLogger(MODULE_ID).error("self-test run failed", err)), AUTO_DELAY_MS);
}
