import { MODULE_ID, readAll, readStatus, setStatus, flush } from "./core.mjs";

/** GM window: every logged warning, error and report from all usedtp modules. */
const { ApplicationV2 } = foundry.applications.api;
const loc = key => game.i18n.localize(`USEDTPLOG.viewer.${key}`);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, cls = "") {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Scroll the chat log to a message and flash it. */
function showMessage(id) {
  try { ui.sidebar?.changeTab?.("chat", "primary"); } catch (err) { /* older layout */ }
  const node = document.querySelector(`.chat-log [data-message-id="${id}"]`);
  if (!node) return false;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("ul-flash");
  setTimeout(() => node.classList.remove("ul-flash"), 2500);
  return true;
}

export class LogViewer extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "usedtp-logger-viewer",
    tag: "div",
    classes: ["usedtp-logger-viewer"],
    window: { title: "USEDTPLOG.viewer.title", resizable: true, icon: "fa-solid fa-scroll" },
    position: { width: 820, height: 640 }
  };

  entries = null;
  status = {};
  module = "all";
  kind = "problems";
  showClosed = false;
  error = null;

  async load() {
    this.error = null;
    try {
      await flush();
      const byId = new Map();
      for (const e of await readAll()) byId.set(e.id ?? `${e.t}|${e.msg}`, e);
      this.entries = [...byId.values()].sort((a, b) => String(b.t).localeCompare(String(a.t)));
      this.status = await readStatus();
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.entries = [];
    }
  }

  async _prepareContext() {
    if (!this.entries) await this.load();
    return {};
  }

  filtered() {
    return (this.entries ?? []).filter(e => {
      if (this.module !== "all" && e.module !== this.module) return false;
      if (!this.showClosed && this.status[e.id]) return false;
      if (this.kind === "problems") return e.level === "error" || e.level === "report" || e.category === "unclear-auto";
      if (this.kind === "reports") return e.level === "report";
      return true;
    });
  }

  async _renderHTML() {
    const root = el("div", "ul-viewer");
    const bar = el("div", "ul-bar");

    const mods = [...new Set((this.entries ?? []).map(e => e.module))].sort();
    const modSel = el("select");
    for (const m of ["all", ...mods]) {
      const o = el("option", "", m === "all" ? loc("allModules") : m);
      o.value = m;
      o.selected = m === this.module;
      modSel.append(o);
    }
    modSel.addEventListener("change", () => { this.module = modSel.value; this.render(); });

    const kindSel = el("select");
    for (const k of ["problems", "reports", "everything"]) {
      const o = el("option", "", loc(`kind_${k}`));
      o.value = k;
      o.selected = k === this.kind;
      kindSel.append(o);
    }
    kindSel.addEventListener("change", () => { this.kind = kindSel.value; this.render(); });

    const closed = el("label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = this.showClosed;
    cb.addEventListener("change", () => { this.showClosed = cb.checked; this.render(); });
    closed.append(cb, document.createTextNode(` ${loc("showClosed")}`));

    bar.append(modSel, kindSel, closed,
      button(loc("refresh"), async () => { this.entries = null; await this.render(); }),
      button(loc("export"), () => this.export()));
    root.append(bar);

    if (this.error) root.append(el("p", "ul-error", this.error));
    const list = this.filtered();
    if (!list.length) root.append(el("p", "ul-empty", loc("empty")));
    for (const e of list.slice(0, 300)) root.append(this.card(e));
    return root;
  }

  card(e) {
    const card = el("div", `ul-card ul-${e.level}${e.category ? ` ul-${e.category}` : ""}`);
    const head = el("div", "ul-head");
    const tag = e.level === "report" ? `${loc("report")}: ${e.category}` : e.category === "unclear-auto" ? loc("unclearAuto") : e.level;
    head.append(el("strong", "", tag.toUpperCase()));
    head.append(el("span", "", ` ${new Date(e.t).toLocaleString()} · ${e.moduleTitle ?? e.module} · ${e.user ?? "?"}`));
    const st = this.status[e.id];
    if (st) head.append(el("span", "ul-status", st.s === "fixed" ? `${loc("fixed")}${st.v ? ` ${st.v}` : ""}` : loc("wontfix")));
    card.append(head);
    card.append(el("div", "ul-msg", e.msg));
    if (e.comment) card.append(el("blockquote", "", e.comment));
    if (e.data !== undefined) {
      const d = el("details");
      d.append(el("summary", "", loc("details")));
      d.append(el("pre", "", JSON.stringify({ data: e.data, versions: e.versions, scene: e.scene }, null, 2)));
      card.append(d);
    }
    const actions = el("div", "ul-actions");
    const messageId = e.data?.messageId;
    if (messageId) {
      const go = button(loc("showMessage"), () => { if (!showMessage(messageId)) ui.notifications.warn(loc("notInLog")); });
      go.disabled = !game.messages?.get(messageId);
      actions.append(go);
    }
    if (!st) {
      actions.append(
        button(loc("markFixed"), () => this.mark(e, { s: "fixed", v: e.versions?.module })),
        button(loc("markWontfix"), () => this.mark(e, { s: "wontfix" })));
    } else {
      actions.append(button(loc("reopen"), () => this.mark(e, null)));
    }
    card.append(actions);
    return card;
  }

  async mark(e, status) {
    try { this.status = await setStatus(e.id, status); } catch (err) { ui.notifications.error(String(err?.message ?? err)); }
    this.render();
  }

  export() {
    const list = this.filtered();
    const name = `usedtp-logs-${this.module}-${new Date().toISOString().slice(0, 10)}.json`;
    foundry.utils.saveDataToFile(JSON.stringify(list, null, 2), "application/json", name);
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}

/** Player and GM entry point for the Error/Unclear dialog, as a settings menu. */
export class ReportLauncher extends ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "usedtp-logger-report-launcher", window: { title: "USEDTPLOG.reportTitle" } };
  async render() {
    const { openReportDialog } = await import("./core.mjs");
    openReportDialog({});
    return this;
  }
}

export function registerMenus() {
  game.settings.registerMenu(MODULE_ID, "viewer", {
    name: "USEDTPLOG.viewer.menuName",
    label: "USEDTPLOG.viewer.menuLabel",
    hint: "USEDTPLOG.viewer.menuHint",
    icon: "fa-solid fa-scroll",
    type: LogViewer,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "report", {
    name: "USEDTPLOG.reportMenuName",
    label: "USEDTPLOG.reportMenuLabel",
    hint: "USEDTPLOG.reportMenuHint",
    icon: "fa-solid fa-flag",
    type: ReportLauncher,
    restricted: false
  });
}
