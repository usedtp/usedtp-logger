import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mocked Foundry globals. core.mjs reads them only when called.
let sent, uploads, notes, me, users;
function setup({ meId, gms = [], players = [] }) {
  sent = []; uploads = []; notes = [];
  users = new Map();
  for (const id of gms) users.set(id, { id, isGM: true, active: true, name: id });
  for (const id of players) users.set(id, { id, isGM: false, active: true, name: id });
  me = users.get(meId);
  globalThis.game = {
    ready: true,
    version: "14.370",
    system: { id: "dnd5e", version: "6.0.6" },
    user: me,
    users: { get: id => users.get(id) },
    modules: { get: () => ({ version: "test", title: "Test" }) },
    settings: { get: (m, k) => ({ consoleLevel: "error", persistInfo: true, persistDebug: false })[k] },
    socket: { emit: (ch, data) => sent.push(data) },
    i18n: { format: (k) => k, localize: k => k },
    scenes: { viewed: null }
  };
  globalThis.ui = { notifications: { error: m => notes.push(m), info: m => notes.push(m), warn: m => notes.push(m) } };
  let n = 0;
  globalThis.foundry = {
    utils: { randomID: () => `id${n++}` },
    applications: { apps: { FilePicker: { implementation: {
      browse: async () => ({ files: [], dirs: [] }),
      createDirectory: async () => ({}),
      upload: async (src, dir, file) => { uploads.push({ dir, name: file.name, body: JSON.parse(await file.text()) }); return {}; }
    } } } }
  };
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
}

const core = await import("../scripts/core.mjs");

beforeEach(() => core._resetPresence());

test("a GM that is not the first GM writes its own error at once", async () => {
  setup({ meId: "gmB", gms: ["gmA", "gmB"] });
  const log = core.register("mod-a");
  const outcome = await log.error("boom", new Error("x"));
  assert.equal(outcome, "logged");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body[0].msg, "boom");
  assert.equal(sent.filter(d => d.action === "entry").length, 0);
});

test("a player with no GM running the logger queues locally", async () => {
  setup({ meId: "p1", gms: ["gmA"], players: ["p1"] });
  const outcome = await core.register("mod-b").report("error", { comment: "c" });
  assert.equal(outcome, "queued");
  assert.equal(uploads.length, 0);
});

test("writer is the lowest id among GMs that announced, not a stale GM", () => {
  setup({ meId: "p1", gms: ["gmA", "gmZ"], players: ["p1"] });
  assert.equal(core.writerId(), null);
  core.onSocket({ action: "hello", from: "gmZ" });
  assert.equal(core.writerId(), "gmZ"); // gmA never announced: its logger is off
  core.onSocket({ action: "here", from: "gmA", to: "p1" });
  assert.equal(core.writerId(), "gmA");
  core.onUserConnected({ id: "gmA" }, false);
  assert.equal(core.writerId(), "gmZ");
});

test("only the chosen GM writes a player's entry and acks it", async () => {
  setup({ meId: "gmZ", gms: ["gmA", "gmZ"], players: ["p1"] });
  core.announce();
  core.onSocket({ action: "hello", from: "gmA" });
  const entry = { id: "e1", module: "mod-c", level: "error", msg: "m", userId: "p1" };
  core.onSocket({ action: "entry", entry, from: "p1" }); // gmA is the writer
  await new Promise(r => setTimeout(r, 10));
  assert.equal(uploads.length, 0);
  core.onUserConnected({ id: "gmA" }, false);
  core.onSocket({ action: "entry", entry, from: "p1" }); // now gmZ is the writer
  await new Promise(r => setTimeout(r, 10));
  assert.equal(uploads.length, 1);
  assert.ok(sent.some(d => d.action === "ack" && d.id === "e1" && d.to === "p1"));
});

test("a GM answers hello with here", () => {
  setup({ meId: "gmA", gms: ["gmA"], players: ["p1"] });
  core.onSocket({ action: "hello", from: "p1" });
  assert.ok(sent.some(d => d.action === "here" && d.from === "gmA" && d.to === "p1"));
});

test("guard reports the real outcome and still returns at once", async () => {
  setup({ meId: "gmA", gms: ["gmA"] });
  const log = core.register("mod-d");
  const r = await log.guard("act", () => { throw new Error("bad"); });
  assert.equal(r, undefined);
  await new Promise(res => setTimeout(res, 10));
  assert.deepEqual(notes, ["USEDTPLOG.failed_logged"]);
  assert.equal(uploads.length, 1);
});
