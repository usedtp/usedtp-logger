import { test } from "node:test";
import assert from "node:assert/strict";

// Mocked Foundry, enough for the self-test runner and the logger it reports to.
const uploads = []; const whispers = []; const notes = []; const deleted = [];
const store = new Map([["usedtp-logger.consoleLevel", "error"], ["usedtp-logger.persistInfo", true], ["usedtp-logger.persistDebug", false]]);
const hooks = new Map(); let hookId = 0;
const gm = { id: "gm1", isGM: true, isActiveGM: true, active: true, name: "GM" };
globalThis.game = {
  ready: true, version: "14.370", system: { id: "dnd5e", version: "6.0.6" },
  user: gm,
  users: { get: id => (id === "gm1" ? gm : null), filter: fn => [gm].filter(fn), activeGM: gm },
  modules: { get: id => ({ version: id === "mod-a" ? "2.0.0" : "1.0.0", title: id }) },
  settings: {
    settings: new Map(),
    get: (m, k) => store.get(`${m}.${k}`),
    set: async (m, k, v) => { store.set(`${m}.${k}`, structuredClone(v)); return v; },
    register: (m, k, o) => { if (!store.has(`${m}.${k}`)) store.set(`${m}.${k}`, o.default); }
  },
  socket: { emit() {} },
  i18n: { format: k => k, localize: k => k },
  scenes: { viewed: null },
  messages: { get: id => ({ delete: async () => deleted.push(`msg:${id}`) }) },
  folders: { find: () => null }
};
globalThis.ui = { notifications: { error: m => notes.push(m), info: m => notes.push(m), warn: m => notes.push(m) } };
let n = 0;
globalThis.foundry = {
  utils: { randomID: () => `id${n++}`, deepClone: v => structuredClone(v) },
  applications: { apps: { FilePicker: { implementation: {
    browse: async () => ({ files: [], dirs: [] }), createDirectory: async () => ({}),
    upload: async (src, dir, file) => { uploads.push({ dir, body: JSON.parse(await file.text()) }); return {}; }
  } } } }
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Hooks = {
  on: (name, fn) => { const id = ++hookId; hooks.set(id, { name, fn }); return id; },
  off: (name, id) => hooks.delete(id),
  call: (name, ...a) => { for (const h of hooks.values()) if (h.name === name) h.fn(...a); }
};
globalThis.ChatMessage = { implementation: { create: async d => { whispers.push(d); return d; } } };

const selfTest = await import("../scripts/selftest.mjs");
selfTest.registerSettings();
const logged = () => uploads.flatMap(u => u.body);

test("a passing and a failing step are recorded; the failure reaches usedtp Logger", async () => {
  selfTest.register("mod-a", async t => {
    await t.step("passes", async () => t.ok(true));
    await t.step("fails", async () => t.equal(1, 2, "one is two"));
  });
  const r = await selfTest.runSuite("mod-a");
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.match(r.steps[1].error, /one is two/);
  assert.ok(logged().some(e => e.module === "mod-a" && e.level === "error" && /self-test failed: fails/.test(e.msg)));
});

test("chat cards made by the suite are removed; restore steps run", async () => {
  let restored = false;
  selfTest.register("mod-b", async t => {
    t.restore.push(() => { restored = true; });
    Hooks.call("createChatMessage", { id: "c1", author: { id: "gm1" } });
    await t.step("ok", async () => t.ok(true));
  });
  await selfTest.runSuite("mod-b");
  assert.ok(restored);
  assert.ok(deleted.includes("msg:c1"));
});

test("runPending runs each version once, whispers a summary, and skips are retried", async () => {
  let runs = 0;
  let skip = true;
  selfTest.register("mod-c", async t => { runs++; if (skip) return t.skip("not ready"); await t.step("ok", async () => t.ok(true)); });
  const first = await selfTest.runPending();
  assert.ok(first.some(r => r.moduleId === "mod-c" && r.skipped));
  assert.ok(whispers.length >= 1 && /usedtp self-test/.test(whispers.at(-1).content));
  skip = false;
  await selfTest.runPending();
  assert.equal(runs, 2, "skipped suite runs again");
  await selfTest.runPending();
  assert.equal(runs, 2, "same version is not run twice");
  assert.equal(store.get("usedtp-logger.selfTestState")["mod-c"].version, "1.0.0");
});

test("another browser holding the lock stops this one", async () => {
  await game.settings.set("usedtp-logger", "selfTestLock", { client: "other", at: Date.now() });
  let ran = false;
  selfTest.register("mod-d", async () => { ran = true; });
  const r = await selfTest.runPending({ force: true });
  assert.equal(r.length, 0);
  assert.equal(ran, false);
});
