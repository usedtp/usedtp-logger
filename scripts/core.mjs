/*
 * usedtp Logger core.
 *
 * Every usedtp module registers here and gets one logger. Entries go to:
 *  - the browser console (detail level is a client setting), and
 *  - the shared file log in Data/usedtp-logs/<module>/YYYY-MM-DD/HHMMSS-nnn-id.json, written only by the
 *    active GM's browser. Other browsers send warn/error/report entries to the GM by socket. With no GM
 *    online they wait in local storage and are sent when a GM connects.
 *
 * Browsers cannot delete files through Foundry, so old logs are removed by hand from the Data folder.
 */

export const MODULE_ID = "usedtp-logger";
export const CHANNEL = `module.${MODULE_ID}`;
export const LOG_DIR = "usedtp-logs";
export const STATUS_FILE = "report-status.json";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, report: 50 };
const FLUSH_MS = 30000;
const ACK_MS = 5000;
const QUEUE_KEY = `${MODULE_ID}.pending`;
const DATA_MAX = 8000;

const registry = new Map();
let queue = [];
let timer = null;
let seq = 0;
const madeDirs = new Set();
const waiting = new Map();
let resending = false;

export const isWriter = () => !!game.user?.isGM && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
const FP = () => foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;

function setting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch (err) { return fallback; }
}

/** Plain, size-capped copy of any value so it can be stored as JSON. */
export function safeData(value) {
  if (value === undefined) return undefined;
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value, (k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        if (typeof v.uuid === "string" && typeof v.documentName === "string") return { document: v.documentName, uuid: v.uuid, name: v.name };
      }
      if (typeof v === "function") return undefined;
      return v;
    });
  } catch (err) {
    return String(value);
  }
  if (text === undefined) return undefined;
  if (text.length > DATA_MAX) return { truncated: true, text: text.slice(0, DATA_MAX) };
  return JSON.parse(text);
}

export function versions(moduleId) {
  return {
    foundry: game.version,
    system: `${game.system?.id ?? "?"} ${game.system?.version ?? "?"}`,
    module: moduleId ? game.modules?.get(moduleId)?.version : undefined,
    logger: game.modules?.get(MODULE_ID)?.version
  };
}

/* ---------- Local queue (no GM online) ---------- */

const storage = {
  load() {
    try { return JSON.parse(globalThis.localStorage?.getItem(QUEUE_KEY) ?? "[]") ?? []; } catch (err) { return []; }
  },
  save(list) {
    try {
      if (list.length) globalThis.localStorage?.setItem(QUEUE_KEY, JSON.stringify(list.slice(-500)));
      else globalThis.localStorage?.removeItem(QUEUE_KEY);
    } catch (err) { /* storage blocked */ }
  }
};

/* ---------- File writing (active GM only) ---------- */

export function batchPath(moduleId, date = new Date(), n = 0, id = "") {
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  return { dir: `${LOG_DIR}/${moduleId}/${day}`, name: `${time}-${String(n).padStart(3, "0")}${id ? `-${id}` : ""}.json` };
}

async function ensureDir(path) {
  if (madeDirs.has(path)) return;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (madeDirs.has(p)) continue;
    let exists = false;
    try { await FP().browse("data", p); exists = true; } catch (err) { exists = false; }
    if (!exists) { try { await FP().createDirectory("data", p, {}); } catch (err) { /* made elsewhere */ } }
    madeDirs.add(p);
  }
}

async function upload(dir, name, data) {
  await ensureDir(dir);
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  const res = await FP().upload("data", dir, file, {}, { notify: false });
  if (res === false) throw new Error("upload refused");
  return res;
}

function enqueue(entries, now = false) {
  queue.push(...entries);
  if (now) return flush();
  timer ??= setTimeout(flush, FLUSH_MS);
  return Promise.resolve(0);
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length || !isWriter()) return 0;
  const pending = queue;
  queue = [];
  const byModule = new Map();
  for (const e of pending) {
    const id = e.module ?? "unknown";
    if (!byModule.has(id)) byModule.set(id, []);
    byModule.get(id).push(e);
  }
  let written = 0;
  for (const [id, list] of byModule) {
    const { dir, name } = batchPath(id, new Date(), seq++, foundry.utils.randomID?.(4) ?? "");
    try {
      await upload(dir, name, list);
      written += list.length;
    } catch (err) {
      console.error(`${MODULE_ID} | log write failed`, err);
      queue = list.concat(queue);
      timer ??= setTimeout(flush, FLUSH_MS);
    }
  }
  return written;
}

/* ---------- Sending entries to the GM ---------- */

async function receive(entry) {
  await enqueue([entry], entry.level === "report" || entry.level === "error");
  if (entry.level === "report" && game.user?.isGM && entry.userId !== game.user.id) {
    ui.notifications?.info(game.i18n.format("USEDTPLOG.received", { user: entry.user ?? "?", module: entry.moduleTitle ?? entry.module, category: entry.category ?? "" }));
  }
}

function emitWithAck(entry) {
  return new Promise(res => {
    const t = setTimeout(() => { waiting.delete(entry.id); res(false); }, ACK_MS);
    waiting.set(entry.id, () => { clearTimeout(t); waiting.delete(entry.id); res(true); });
    game.socket.emit(CHANNEL, { action: "entry", entry });
  });
}

function enqueueLocal(entry) {
  const list = storage.load();
  if (!list.some(e => e.id === entry.id)) list.push(entry);
  storage.save(list);
}

/** @returns {Promise<"logged"|"sent"|"queued">} */
export async function deliver(entry) {
  if (isWriter()) { await receive(entry); return "logged"; }
  if (!game.ready || !game.users?.activeGM) { enqueueLocal(entry); return "queued"; }
  if (await emitWithAck(entry)) return "sent";
  enqueueLocal(entry);
  return "queued";
}

export function onSocket(data) {
  if (data?.action === "entry") {
    if (!isWriter() || !data.entry) return;
    receive(data.entry)
      .then(() => game.socket.emit(CHANNEL, { action: "ack", id: data.entry.id, to: data.entry.userId }))
      .catch(err => console.error(`${MODULE_ID} | entry not logged`, err));
  } else if (data?.action === "ack") {
    if (data.to === game.user?.id) waiting.get(data.id)?.();
  }
}

export async function resendQueued() {
  if (resending) return 0;
  const list = storage.load();
  if (!list.length || (!isWriter() && !game.users?.activeGM)) return 0;
  resending = true;
  const left = [];
  try {
    for (const e of list) {
      if (isWriter()) await receive(e);
      else if (!(await emitWithAck(e))) left.push(e);
    }
  } finally {
    storage.save(left);
    resending = false;
  }
  return list.length - left.length;
}

/* ---------- Logger ---------- */

export class Logger {
  constructor(moduleId, { title } = {}) {
    this.moduleId = moduleId;
    this.title = title ?? game.modules?.get(moduleId)?.title ?? moduleId;
    this.seen = new Set();
  }

  #entry(level, msg, data, extra = {}) {
    return {
      id: foundry.utils.randomID(),
      t: new Date().toISOString(),
      module: this.moduleId,
      moduleTitle: this.title,
      level,
      msg: String(msg ?? ""),
      data: safeData(data),
      user: game.user?.name,
      userId: game.user?.id,
      gm: !!game.user?.isGM,
      scene: game.canvas?.scene?.id ?? game.scenes?.viewed?.id,
      versions: versions(this.moduleId),
      ...extra
    };
  }

  #console(level, msg, data) {
    const min = LEVELS[setting("consoleLevel", "warn")] ?? LEVELS.warn;
    if ((LEVELS[level] ?? 0) < min && level !== "report") return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
    if (data === undefined) fn(`${this.moduleId} | ${msg}`);
    else fn(`${this.moduleId} | ${msg}`, data);
  }

  #persist(level) {
    if (level === "error" || level === "warn" || level === "report") return true;
    if (level === "info") return !!setting("persistInfo", false);
    return !!setting("persistDebug", false);
  }

  #log(level, msg, data, extra) {
    this.#console(level, msg, data);
    if (!this.#persist(level)) return Promise.resolve(null);
    const entry = this.#entry(level, msg, data, extra);
    return deliver(entry).catch(err => console.error(`${MODULE_ID} | deliver failed`, err));
  }

  debug(msg, data) { return this.#log("debug", msg, data); }
  info(msg, data) { return this.#log("info", msg, data); }
  warn(msg, data) { return this.#log("warn", msg, data); }

  error(msg, err, data) {
    const payload = err instanceof Error ? { error: err, ...(data ?? {}) } : (data ?? err);
    return this.#log("error", msg, payload);
  }

  /** Something the module could not decide or explain. Logged once per key per session. */
  unclear(key, msg, data) {
    if (this.seen.has(key)) return Promise.resolve(null);
    this.seen.add(key);
    return this.#log("warn", msg, data, { category: "unclear-auto", key });
  }

  /** A report from a person: category "error" or "unclear". */
  report(category, { comment = "", context } = {}) {
    const entry = this.#entry("report", category === "unclear" ? "Unclear report" : "Error report", context, {
      category: category === "unclear" ? "unclear" : "error",
      comment: String(comment ?? "").trim().slice(0, 1000)
    });
    this.#console("report", entry.msg, entry);
    return deliver(entry);
  }

  /** Runs fn and logs anything it throws. Returns fn's result, or undefined on error. */
  async guard(label, fn, data) {
    try { return await fn(); } catch (err) {
      this.error(`${label} failed`, err, data);
      ui.notifications?.error(game.i18n.format("USEDTPLOG.failed", { module: this.title, label }));
      return undefined;
    }
  }

  /** Opens the Error/Unclear dialog for this module. */
  openReport(category = "error", context) {
    return openReportDialog({ moduleId: this.moduleId, category, context });
  }
}

export function register(moduleId, options = {}) {
  if (!registry.has(moduleId)) registry.set(moduleId, new Logger(moduleId, options));
  return registry.get(moduleId);
}

export function get(moduleId) {
  return registry.get(moduleId) ?? register(moduleId);
}

export const registered = () => [...registry.values()];

/* ---------- Uncaught errors from registered modules ---------- */

export function moduleFromStack(stack) {
  const m = /modules\/([^/]+)\//.exec(String(stack ?? ""));
  return m ? m[1] : null;
}

export function captureUncaught() {
  const handle = (err, origin) => {
    const id = moduleFromStack(err?.stack);
    if (!id || !registry.has(id)) return;
    registry.get(id).error(`uncaught (${origin})`, err instanceof Error ? err : new Error(String(err)));
  };
  globalThis.addEventListener?.("error", ev => handle(ev.error, "error"));
  globalThis.addEventListener?.("unhandledrejection", ev => handle(ev.reason, "promise"));
}

/* ---------- Report dialog ---------- */

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const loc = key => game.i18n.localize(`USEDTPLOG.${key}`);

export async function openReportDialog({ moduleId, category = "error", context } = {}) {
  const { DialogV2 } = foundry.applications.api;
  const mods = registered();
  if (!mods.length) return ui.notifications?.warn(loc("noModules"));
  const options = mods.map(l => `<option value="${esc(l.moduleId)}" ${l.moduleId === moduleId ? "selected" : ""}>${esc(l.title)}</option>`).join("");
  const content = `
    <label>${esc(loc("module"))} <select name="module">${options}</select></label>
    <label>${esc(loc("category"))}
      <select name="category">
        <option value="error" ${category === "error" ? "selected" : ""}>${esc(loc("error"))}</option>
        <option value="unclear" ${category === "unclear" ? "selected" : ""}>${esc(loc("unclear"))}</option>
      </select>
    </label>
    <label>${esc(loc("comment"))}</label>
    <textarea name="comment" rows="5" maxlength="1000" placeholder="${esc(loc("placeholder"))}"></textarea>
    <p class="hint">${esc(loc("disclaimer"))}</p>`;
  const result = await DialogV2.prompt({
    window: { title: loc("reportTitle"), icon: "fa-solid fa-flag" },
    classes: ["usedtp-logger-report"],
    content,
    ok: {
      label: loc("send"),
      callback: (event, button) => {
        const f = button.form.elements;
        return { module: f.module.value, category: f.category.value, comment: f.comment.value };
      }
    },
    rejectClose: false
  });
  if (!result) return null;
  const outcome = await get(result.module).report(result.category, { comment: result.comment, context });
  ui.notifications?.info(loc(`outcome_${outcome}`));
  return outcome;
}

/* ---------- Reading logs (GM only) ---------- */

async function browse(path) {
  try { return await FP().browse("data", path); } catch (err) { return { files: [], dirs: [] }; }
}

async function readJSON(path) {
  try {
    const res = await fetch(`${foundry.utils.getRoute(path)}?t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch (err) { return null; }
}

export async function listLogFiles() {
  const files = [];
  const root = await browse(LOG_DIR);
  for (const modDir of root.dirs ?? []) {
    const mod = await browse(modDir);
    for (const dayDir of mod.dirs ?? []) {
      const day = await browse(dayDir);
      files.push(...(day.files ?? []).filter(f => f.endsWith(".json")));
    }
  }
  return files.sort();
}

export async function readAll() {
  const out = [];
  for (const path of await listLogFiles()) {
    const list = await readJSON(path);
    if (!Array.isArray(list)) continue;
    for (const e of list) out.push({ ...e, _file: path });
  }
  return out;
}

export async function readStatus() {
  return (await readJSON(`${LOG_DIR}/${STATUS_FILE}`)) ?? {};
}

export async function setStatus(ids, status) {
  const all = await readStatus();
  for (const id of [].concat(ids)) {
    if (status === null) delete all[id];
    else all[id] = { ...status, at: new Date().toISOString() };
  }
  await upload(LOG_DIR, STATUS_FILE, all);
  return all;
}
