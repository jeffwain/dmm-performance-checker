/**
 * DMM Performance Checker — Dashboard
 * -----------------------------------
 * ApplicationV2, no Handlebars templates (raw HTML so tables can be built dynamically and the
 * module stays a single self-contained unit). Opened from Configure Settings › Module Settings.
 */

import {
  MODULE_ID, bytes, ms, canvasCensus, domCensus, dataCensus, memoryCensus,
  resourceCensus, idleChurnTest
} from "./census.mjs";
import { scorecard, findings, heapTrend, drift, takeSnapshot, diffSnapshots } from "./analysis.mjs";

/* Ring-buffer-safe: findings are re-derived every render, so the click handler works from the
   array that produced the markup, not from a stale index into a mutating source. */

const { ApplicationV2 } = foundry.applications.api;
const P = () => globalThis.DMMPC;

/* Version-tolerant lookups for helpers that moved namespace between generations. */
const DialogV2 = () => foundry.applications.api.DialogV2;
const FormData_ = () => foundry.applications?.ux?.FormDataExtended ?? globalThis.FormDataExtended;
/**
 * Copy text to the clipboard, degrading through three tiers.
 *
 * `navigator.clipboard` is undefined on non-secure origins, which is how most people reach a
 * self-hosted Foundry (http://192.168.x.x:30000 is not a secure context; only localhost and
 * https are). Firefox is stricter than Chromium here. The legacy execCommand path still works
 * on plain http, and if even that fails we show the text in a selectable box rather than
 * pretending the copy succeeded.
 */
async function copyText(text, label = "Text") {
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      ui.notifications?.info(`${label} copied to clipboard.`);
      return true;
    } catch (e) { /* fall through */ }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const okDone = document.execCommand("copy");
    ta.remove();
    if (okDone) {
      ui.notifications?.info(`${label} copied to clipboard.`);
      return true;
    }
  } catch (e) { /* fall through */ }

  // Last resort: give them something they can copy by hand.
  const esc2 = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  await DialogV2().prompt({
    window: { title: `${label} — copy manually`, icon: "fa-solid fa-clipboard" },
    position: { width: 700 },
    content: `<p style="font-size:12px;margin-bottom:6px">Your browser blocked automatic clipboard access
      (this happens on non-secure origins — <code>http://</code> on anything other than localhost).
      The text is selected below; press <b>Ctrl+C</b>.</p>
      <textarea readonly style="width:100%;height:340px;font-family:monospace;font-size:11px">${esc2(text)}</textarea>`,
    ok: { label: "Done" },
    rejectClose: false
  }).then(() => {}).catch(() => {});
  // Select the content once the dialog is up.
  setTimeout(() => {
    const ta = document.querySelector(".application.dialog textarea, .dialog textarea");
    if (ta) { ta.focus(); ta.select(); }
  }, 120);
  return false;
}

/**
 * A self-contained listener counter that shares no code with this module.
 *
 * Offered because the honest answer to "is your listener count wrong again?" is that you should
 * be able to check without trusting this module's bookkeeping. This patches the prototype fresh,
 * tallies net add-minus-remove per target kind, and is deliberately trivial enough to read in
 * full before running it.
 */
const INDEPENDENT_CHECK = [
  "(() => {",
  "  const proto = EventTarget.prototype;",
  "  const add = proto.addEventListener, rem = proto.removeEventListener;",
  "  const tally = new Map();",
  "  const kind = t => t === window ? 'window'",
  "    : t === document ? 'document'",
  "    : t === document.body ? 'body'",
  "    : (t && t.nodeType === 1) ? 'element' : 'other';",
  "  const bump = (t, type, n) => {",
  "    const k = kind(t) + '  ' + type;",
  "    tally.set(k, (tally.get(k) || 0) + n);",
  "  };",
  "  proto.addEventListener = function (type) { bump(this, type, 1); return add.apply(this, arguments); };",
  "  proto.removeEventListener = function (type) { bump(this, type, -1); return rem.apply(this, arguments); };",
  "  window.__lt = () => console.table([...tally].filter(([, v]) => v !== 0)",
  "    .sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ target: k.split('  ')[0], event: k.split('  ')[1], net: v })));",
  "  window.__ltStop = () => { proto.addEventListener = add; proto.removeEventListener = rem; };",
  "  window.__ltNodes = () => document.getElementsByTagName('*').length;",
  "  console.log('Counting from now. Note __ltNodes(), open+close the sheet, then run __lt() and __ltNodes() again.');",
  "  console.log('Rows with target \"element\" going up are normal — those elements get discarded.');",
  "  console.log('Rows with target \"window\", \"document\" or \"body\" going up are the real leak. __ltStop() to undo.');",
  "})();"
].join("\n");

const saveFile = (data, type, name) => {
  const fn = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  if (typeof fn === "function") return fn(data, type, name);
  // Last-resort fallback so an export never silently fails.
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

/* ---------------------------------------------------------------------------------------- */
/* Small HTML helpers                                                                        */
/* ---------------------------------------------------------------------------------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (isFinite(n) ? Math.round(n).toLocaleString() : "—");
const pct = (n) => (isFinite(n) ? `${n.toFixed(1)}%` : "—");

/** Inline SVG sparkline. No chart library, no CDN, no layout thrash. */
function spark(values, { w = 320, h = 44, color = "var(--dmm-accent)", fill = true, min = null, max = null } = {}) {
  const vals = values.filter((v) => isFinite(v));
  if (vals.length < 2) return `<div class="dmm-spark-empty">not enough data yet</div>`;
  const lo = min ?? Math.min(...vals);
  const hi = max ?? Math.max(...vals);
  const range = hi - lo || 1;
  const step = w / (vals.length - 1);
  let d = "";
  for (let i = 0; i < vals.length; i++) {
    const x = i * step;
    const y = h - ((vals[i] - lo) / range) * (h - 4) - 2;
    d += `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  const area = fill ? `<path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity="0.15"/>` : "";
  return `<svg class="dmm-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

/** Horizontal proportional bar used inside table cells. */
function bar(value, maxValue, label) {
  const p = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  return `<div class="dmm-bar"><div class="dmm-bar-fill" style="width:${p.toFixed(1)}%"></div><span>${esc(label)}</span></div>`;
}

function table(id, columns, rows, { sort = null, empty = "No data.", rowClass = () => "" } = {}) {
  if (!rows.length) return `<p class="dmm-empty">${esc(empty)}</p>`;
  const head = columns.map((c) => {
    const active = sort && sort.key === c.key;
    const arrow = active ? (sort.dir > 0 ? " ▲" : " ▼") : "";
    return `<th class="${c.align || "left"}${active ? " sorted" : ""}" data-action="sort" data-table="${esc(id)}" data-key="${esc(c.key)}" title="Sort by ${esc(c.label)}">${esc(c.label)}${arrow}</th>`;
  }).join("");
  const body = rows.map((r) => {
    const cells = columns.map((c) => `<td class="${c.align || "left"}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join("");
    return `<tr class="${rowClass(r)}">${cells}</tr>`;
  }).join("");
  return `<table class="dmm-table" data-table="${esc(id)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sortRows(rows, sort) {
  if (!sort) return rows;
  const { key, dir } = sort;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x ?? "").localeCompare(String(y ?? "")) * dir;
  });
}

function sevIcon(sev) {
  return sev === 3 ? `<i class="fa-solid fa-circle-exclamation dmm-crit"></i>`
    : sev === 2 ? `<i class="fa-solid fa-triangle-exclamation dmm-warn"></i>`
      : `<i class="fa-solid fa-circle-info dmm-info"></i>`;
}

/* ---------------------------------------------------------------------------------------- */
/* Frozen detail modal                                                                        */
/* ---------------------------------------------------------------------------------------- */

let _detailSeq = 0;

/**
 * A static, non-refreshing window holding a deep copy of one finding (or one error) plus all the
 * supporting evidence as it stood at the moment you clicked.
 *
 * This exists because the dashboard refreshes every two seconds, which made inline accordions
 * useless: they collapsed on re-render and the numbers underneath them moved while you were
 * reading. Diagnosis needs a stable frame of reference, so the snapshot is taken once and never
 * touched again. Multiple modals can be open at once for side-by-side comparison.
 */
export class FindingDetail extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["dmm-pc", "dmm-detail"],
    tag: "div",
    window: {
      title: "Finding detail",
      icon: "fa-solid fa-magnifying-glass-chart",
      resizable: true,
      contentClasses: ["dmm-pc-content"]
    },
    position: { width: 760, height: 620 },
    actions: {
      copyDetail: FindingDetail.prototype._actCopy,
      muteFrom: FindingDetail.prototype._actMute
    }
  };

  constructor(options = {}) {
    super(options);
    this.payload = options.payload;
  }

  get title() {
    const f = this.payload?.finding;
    return f ? `${f.sevName === "critical" ? "Critical" : f.sevName === "warning" ? "Warning" : "Info"} — ${f.title}` : "Detail";
  }

  async _renderHTML() {
    const pl = this.payload;
    if (!pl) return `<p class="dmm-empty">Nothing captured.</p>`;
    return pl.kind === "error" ? this._renderError(pl) : this._renderFinding(pl);
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  /** Same reasoning as the dashboard: own the dispatch so the buttons cannot silently die. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!root || root.__dmmDelegated) return;
    root.__dmmDelegated = true;
    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target || !root.contains(target) || event.__dmmHandled) return;
      const h = this.options?.actions?.[target.dataset.action] ?? FindingDetail.DEFAULT_OPTIONS.actions[target.dataset.action];
      const fn = typeof h === "function" ? h : h?.handler;
      if (typeof fn !== "function") return;
      event.__dmmHandled = true;
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(fn.call(this, event, target)).catch((err) =>
        console.error(`${MODULE_ID} | detail action failed`, err));
    }, { capture: true });
  }

  _renderFinding(pl) {
    const f = pl.finding;
    const e = pl.evidence;
    return `
    <div class="dmm-body">
      <div class="dmm-frozen-banner">
        <i class="fa-solid fa-snowflake"></i>
        Snapshot captured ${esc(new Date(pl.capturedAt).toLocaleTimeString())} at
        ${pl.sessionMinutes.toFixed(1)} min into the measurement window. <b>This view does not update.</b>
      </div>

      <div class="dmm-card">
        <h3>${sevIcon(f.sev)} ${esc(f.title)}
          ${f.owner ? `<code>${esc(f.owner)}</code>` : ""}
          <span class="dmm-metric">${esc(f.metric)}</span></h3>
        <p class="dmm-detail-text">${esc(f.detail)}</p>
        <p class="dmm-detail-text dmm-action"><i class="fa-solid fa-arrow-right"></i> ${esc(f.action)}</p>
        <div class="dmm-detail-buttons">
          <button type="button" class="dmm-mini" data-action="copyDetail">Copy finding + evidence</button>
          ${e.row && e.row.id !== "core" && e.row.id !== "unattributed"
            ? `<button type="button" class="dmm-mini" data-action="muteFrom" data-id="${esc(e.row.id)}">Mute ${esc(e.row.id)} and watch FPS</button>` : ""}
        </div>
      </div>

      ${this._renderVitals(pl.vitals)}
      ${e.row ? this._renderOwnerCard(e) : ""}
      ${this._renderSourceEvidence(f.source, e)}
    </div>`;
  }

  _renderVitals(v) {
    if (!v) return "";
    return `<div class="dmm-card">
      <h3><i class="fa-solid fa-heart-pulse"></i> Client vitals at capture</h3>
      <div class="dmm-kv">
        <div><label>FPS</label><b>${v.fps ? v.fps.toFixed(0) : "—"}</b></div>
        <div><label>Heap</label><b>${bytes(v.heap)}</b></div>
        <div><label>DOM elements</label><b>${num(v.domNodes)}</b></div>
        <div><label>Live listeners</label><b>${num(v.listeners)}</b></div>
        <div><label>Live intervals</label><b>${num(v.intervals)}</b></div>
        <div><label>Open apps</label><b>${num(v.apps)}</b></div>
        <div><label>Chat in DOM</label><b>${num(v.chatDom)}</b></div>
        <div><label>Frames &gt; 33 ms</label><b>${num(v.droppedFrames)}</b></div>
      </div>
    </div>`;
  }

  _renderOwnerCard(e) {
    const r = e.row;
    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-cube"></i> ${esc(r.title)} <small>${esc(r.id)}</small></h3>
      <div class="dmm-kv">
        <div><label>Impact</label><b>${r.score}</b></div>
        <div><label>CPU share</label><b>${pct(r.cpuPct)}</b></div>
        <div><label>CPU time</label><b>${ms(r.cpuMs)}</b></div>
        <div><label>ms / frame</label><b>${r.msPerFrame.toFixed(3)}</b></div>
        <div><label>Hook calls</label><b>${num(r.hookCalls)}</b></div>
        <div><label>Worst call</label><b>${ms(r.hookMax)}</b><small>${esc(r.hookMaxName || "—")}</small></div>
        ${r.lwCalls ? `<div><label>libWrapper (own)</label><b>${ms(r.lwSelf)}</b><small>of ${ms(r.lwInclusive)} enveloped</small></div>` : ""}
        <div><label>Live intervals</label><b>${num(r.liveIntervals)}</b></div>
        <div><label>Listeners added</label><b>${num(r.listenerRegs)}</b></div>
        <div><label>DOM ops</label><b>${num(r.domOps)}</b></div>
        <div><label>DB writes</label><b>${num(r.dbDocs)}</b></div>
        <div><label>Net requests</label><b>${num(r.netRequests)}</b></div>
        <div><label>Errors</label><b>${num(r.errors)}</b></div>
        <div><label>Payload</label><b>${bytes(r.assetBytes)}</b></div>
        <div><label>Retained</label><b>${r.retainedBytes ? bytes(r.retainedBytes) : "not scanned"}</b></div>
      </div>
    </div>

    ${e.hooks.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-anchor"></i> Its hook callbacks</h3>
      ${table("dh", [
        { key: "hook", label: "Hook" },
        { key: "calls", label: "Calls", align: "right", render: (x) => num(x.calls) },
        { key: "total", label: "Total", align: "right", render: (x) => ms(x.total) },
        { key: "self", label: "Self", align: "right", render: (x) => ms(x.self) },
        { key: "avg", label: "Avg", align: "right", render: (x) => ms(x.calls ? x.total / x.calls : 0) },
        { key: "max", label: "Worst", align: "right", render: (x) => ms(x.max) },
        { key: "live", label: "Live", align: "right" }
      ], e.hooks)}
    </div>` : ""}

    ${e.intervals.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-clock"></i> Its live background timers</h3>
      ${table("di", [
        { key: "delay", label: "Every", align: "right", render: (x) => `${x.delay} ms` },
        { key: "fires", label: "Fired", align: "right", render: (x) => num(x.fires) },
        { key: "totalMs", label: "Total time", align: "right", render: (x) => ms(x.totalMs) },
        { key: "created", label: "Created", render: (x) => new Date(x.created).toLocaleTimeString() }
      ], e.intervals)}
      <p class="dmm-help">These run whether or not anyone is doing anything. Multiply "Every" into an hour to see the true call count for a long session.</p>
    </div>` : ""}

    ${e.libWrapper?.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-layer-group"></i> Its libWrapper wrappers</h3>
      ${table("dlw", [
        { key: "target", label: "Wrapped target" },
        { key: "type", label: "Type" },
        { key: "calls", label: "Calls", align: "right", render: (x) => num(x.calls) },
        { key: "self", label: "Own", align: "right", render: (x) => `<b>${ms(x.self)}</b>` },
        { key: "inclusive", label: "Enveloped", align: "right", render: (x) => `<span class="dmm-dim">${ms(x.inclusive)}</span>` },
        { key: "ratio", label: "Own share", align: "right", render: (x) => `${x.ratio.toFixed(1)}%` }
      ], e.libWrapper)}
      <p class="dmm-help">Only <b>Own</b> is charged to this package. A low own-share means it is a pass-through
      wrapper and the cost belongs to whatever it wraps, not to this package.</p>
    </div>` : ""}

    ${e.listeners.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-ear-listen"></i> Its DOM listeners</h3>
      ${table("dl", [
        { key: "type", label: "Event" },
        { key: "attached", label: "Attached", align: "right", render: (x) => num(x.attached) },
        { key: "live", label: "Not removed", align: "right", render: (x) => `<span class="dmm-dim">${num(x.live)}</span>` },
        { key: "regs", label: "Added", align: "right", render: (x) => num(x.regs) },
        { key: "calls", label: "Fired", align: "right", render: (x) => num(x.calls) },
        { key: "total", label: "Total", align: "right", render: (x) => ms(x.total) },
        { key: "targets", label: "Attached to", render: (x) => `<small>${esc(x.targets)}</small>` }
      ], e.listeners)}
    </div>` : ""}

    ${e.spans.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-list-timeline"></i> Its slowest recent callbacks</h3>
      ${table("ds", [
        { key: "t", label: "When", render: (x) => new Date(x.t).toLocaleTimeString() },
        { key: "kind", label: "Kind" },
        { key: "label", label: "What" },
        { key: "dur", label: "Total", align: "right", render: (x) => ms(x.dur) },
        { key: "self", label: "Self", align: "right", render: (x) => ms(x.self) }
      ], e.spans)}
    </div>` : ""}

    ${e.longTasks.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-hourglass-half"></i> Long tasks it contributed to</h3>
      ${table("dlt", [
        { key: "t", label: "When", render: (x) => new Date(x.t).toLocaleTimeString() },
        { key: "dur", label: "Blocked for", align: "right", render: (x) => ms(x.dur) },
        { key: "mine", label: "Its share", align: "right", render: (x) => ms(x.mine) },
        { key: "others", label: "Other packages in the same block" }
      ], e.longTasks)}
    </div>` : ""}

    ${e.errors.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-bug"></i> Its errors</h3>
      ${e.errors.map((x) => `<div class="dmm-err-block">
        <b>${esc(x.message)}</b> <small>×${num(x.count)} · ${esc(x.where)}</small>
        <pre class="dmm-stack">${esc(x.stack || "")}</pre>
      </div>`).join("")}
    </div>` : ""}`;
  }

  /** Freeze the census slice the finding actually rests on, so the numbers cannot move. */
  _renderSourceEvidence(source, e) {
    const c = e.canvas, d = e.dom, da = e.data;
    switch (source) {
      case "canvas":
        if (!c) return "";
        return `<div class="dmm-card">
          <h3><i class="fa-solid fa-map"></i> Canvas state at capture</h3>
          <div class="dmm-kv">
            <div><label>Display objects</label><b>${num(c.totalObjects)}</b></div>
            <div><label>Texture VRAM</label><b>${bytes(c.textures.bytes)}</b></div>
            <div><label>Base textures</label><b>${num(c.textures.count)}</b></div>
            <div><label>Filters</label><b>${num(c.filterCount)}</b><small>on ${num(c.filteredObjects)} objects</small></div>
            <div><label>Ticker listeners</label><b>${num(c.tickerListeners)}</b></div>
            <div><label>Max depth</label><b>${c.maxDepth}</b></div>
          </div>
          ${c.filters?.length ? `<h4>Filters</h4>${table("dcf", [
            { key: "name", label: "Filter" }, { key: "count", label: "Instances", align: "right" },
            { key: "enabled", label: "Enabled", align: "right" }, { key: "on", label: "Applied to" }
          ], c.filters)}` : ""}
          ${c.textures?.biggest?.length ? `<h4>Largest textures</h4>${table("dct", [
            { key: "key", label: "Texture" },
            { key: "w", label: "Size", render: (x) => `${x.w}×${x.h}` },
            { key: "bytes", label: "VRAM", align: "right", render: (x) => bytes(x.bytes) }
          ], c.textures.biggest)}` : ""}
        </div>`;

      case "dom":
      case "growth":
        if (!d) return "";
        return `<div class="dmm-card">
          <h3><i class="fa-solid fa-code"></i> DOM state at capture</h3>
          <div class="dmm-kv">
            <div><label>Elements</label><b>${num(d.total)}</b></div>
            <div><label>Max depth</label><b>${d.depth}</b></div>
            <div><label>Chat in DOM</label><b>${num(d.chat.domMessages)}</b><small>${num(d.chat.nodes)} nodes</small></div>
            <div><label>Nodes / message</label><b>${d.chat.nodesPerMessage}</b></div>
            <div><label>Open apps</label><b>${num(d.apps.open)}</b></div>
            <div><label>CSS rules</label><b>${num(d.cssRules)}</b></div>
          </div>
          <h4>Where the weight is</h4>
          ${table("ddr", [
            { key: "sel", label: "Region" },
            { key: "nodes", label: "Elements", align: "right", render: (x) => num(x.nodes) }
          ], d.byRegion || [])}
          ${e.topListeners?.length ? `<h4>Biggest live listener holders</h4>${table("ddl", [
            { key: "owner", label: "Package" }, { key: "type", label: "Event" },
            { key: "live", label: "Live", align: "right", render: (x) => num(x.live) }
          ], e.topListeners)}` : ""}
        </div>`;

      case "data":
        if (!da) return "";
        return `<div class="dmm-card">
          <h3><i class="fa-solid fa-database"></i> World data at capture</h3>
          ${table("ddf", [
            { key: "namespace", label: "Namespace", render: (x) => `<code>${esc(x.namespace)}</code>${x.installed ? "" : ` <em class="dmm-crit">not installed</em>`}` },
            { key: "bytes", label: "Flag bytes", align: "right", render: (x) => bytes(x.bytes) },
            { key: "docs", label: "Documents", align: "right", render: (x) => num(x.docs) },
            { key: "biggest", label: "Biggest document", render: (x) => (x.biggest ? `${esc(x.biggest.name)} <small>${bytes(x.biggest.bytes)}</small>` : "—") }
          ], da.flags || [])}
        </div>`;

      case "memory": {
        const h = e.heapTrend;
        return `<div class="dmm-card">
          <h3><i class="fa-solid fa-memory"></i> Heap history at capture</h3>
          ${spark(e.heapSeries || [], { h: 70 })}
          <div class="dmm-legend">${h?.valid
            ? `Post-GC floor ${bytes(h.floorStart)} → ${bytes(h.floorEnd)} over ${h.spanMinutes.toFixed(0)} min = ${bytes(h.bytesPerHour)}/hour`
            : "Trend not yet established."}</div>
          ${e.growth?.length ? `<h4>Counters that only go up</h4>${table("dg", [
            { key: "name", label: "Counter" },
            { key: "early", label: "Early", align: "right", render: (x) => num(x.early) },
            { key: "late", label: "Late", align: "right", render: (x) => num(x.late) },
            { key: "pct", label: "Change", align: "right", render: (x) => `${x.pct >= 0 ? "+" : ""}${x.pct.toFixed(0)}%` }
          ], e.growth)}` : ""}
          ${e.retained?.length ? `<h4>Retained by module</h4>${table("dr", [
            { key: "id", label: "Module" },
            { key: "bytes", label: "Estimated", align: "right", render: (x) => bytes(x.bytes) }
          ], e.retained)}` : ""}
        </div>`;
      }

      case "input":
        return e.inputs?.length ? `<div class="dmm-card">
          <h3><i class="fa-solid fa-hand-pointer"></i> Slow interactions at capture</h3>
          <p class="dmm-help">The total splits into three parts with completely different causes.
          <b>Queued</b> = the browser was busy and could not start yet (blame long tasks).
          <b>Handler</b> = the listeners themselves (blame the packages in <b>Running during</b>).
          <b>Paint</b> = time after the handler finished, waiting for the next frame (blame canvas/layout cost).
          Rows marked <em>hover</em> are continuous events whose totals are dominated by paint wait and are
          usually not real lag.</p>
          ${table("dip", [
            { key: "name", label: "Event", render: (x) => `${esc(x.name)}${x.discrete ? "" : ` <em class="dmm-hover-tag">hover</em>`}` },
            { key: "dur", label: "Total", align: "right", render: (x) => ms(x.dur) },
            { key: "delay", label: "Queued", align: "right", render: (x) => ms(x.delay) },
            { key: "processing", label: "Handler", align: "right", render: (x) => `<b class="${x.processing > 80 ? "dmm-crit" : x.processing > 30 ? "dmm-warn" : ""}">${ms(x.processing)}</b>` },
            { key: "present", label: "Paint", align: "right", render: (x) => ms(x.present) },
            { key: "during", label: "Running during", render: (x) => `<small>${esc(x.during)}</small>` },
            { key: "longTask", label: "Long tasks", render: (x) => `<small>${esc(x.longTask)}</small>` },
            { key: "t", label: "When", render: (x) => new Date(x.t).toLocaleTimeString() }
          ], e.inputs)}
        </div>` : "";

      case "socket":
        return e.socket?.length ? `<div class="dmm-card">
          <h3><i class="fa-solid fa-tower-broadcast"></i> Socket traffic at capture</h3>
          ${table("dso", [
            { key: "event", label: "Event" },
            { key: "owner", label: "Package", render: (x) => `<code>${esc(x.owner)}</code>` },
            { key: "count", label: "Count", align: "right", render: (x) => num(x.count) },
            { key: "bytes", label: "Bytes", align: "right", render: (x) => bytes(x.bytes) }
          ], e.socket)}
        </div>` : "";

      default:
        return "";
    }
  }

  _renderError(pl) {
    const e = pl.error;
    return `<div class="dmm-body">
      <div class="dmm-frozen-banner"><i class="fa-solid fa-snowflake"></i>
        Snapshot captured ${esc(new Date(pl.capturedAt).toLocaleTimeString())}. <b>This view does not update.</b></div>
      <div class="dmm-card">
        <h3>${sevIcon(2)} <code>${esc(e.owner)}</code> ${esc(e.message)}</h3>
        <div class="dmm-kv">
          <div><label>Where</label><b>${esc(e.where)}</b></div>
          <div><label>First seen</label><b>${esc(new Date(e.t).toLocaleTimeString())}</b></div>
          <div><label>Occurrences of this signature</label><b>${num(e.signatureCount)}</b></div>
        </div>
        <button type="button" class="dmm-mini" data-action="copyDetail">Copy</button>
      </div>
      <div class="dmm-card"><h3><i class="fa-solid fa-layer-group"></i> Stack</h3>
        <pre class="dmm-stack tall">${esc(e.stack || "(no stack captured)")}</pre></div>
      ${pl.evidence?.row ? this._renderOwnerCard(pl.evidence) : ""}
    </div>`;
  }

  async _actCopy() {
    const pl = this.payload;
    const text = pl.kind === "error"
      ? `[${pl.error.owner}] ${pl.error.message}\n  at ${pl.error.where}, ×${pl.error.signatureCount}\n${pl.error.stack}`
      : [
        `[${pl.finding.sevName.toUpperCase()}] ${pl.finding.owner ? `${pl.finding.owner}: ` : ""}${pl.finding.title} (${pl.finding.metric})`,
        `  ${pl.finding.detail}`,
        `  → ${pl.finding.action}`,
        "",
        `Captured ${new Date(pl.capturedAt).toISOString()}, ${pl.sessionMinutes.toFixed(1)} min into the window.`,
        `Vitals: ${pl.vitals.fps?.toFixed(0)} FPS, heap ${bytes(pl.vitals.heap)}, ${pl.vitals.domNodes} DOM nodes, ${pl.vitals.listeners} listeners.`,
        pl.evidence.row ? `Module: cpu ${pl.evidence.row.cpuPct.toFixed(2)}%, ${pl.evidence.row.msPerFrame.toFixed(3)} ms/frame, ${pl.evidence.row.hookCalls} hook calls, ${pl.evidence.row.liveIntervals} live intervals, ${pl.evidence.row.errors} errors.` : "",
        pl.evidence.hooks?.length ? "Hooks:\n" + pl.evidence.hooks.map((h) => `  ${h.hook}: ${h.calls} calls, ${h.total.toFixed(1)} ms total, ${h.max.toFixed(1)} ms worst`).join("\n") : ""
      ].filter(Boolean).join("\n");
    console.log(text);
    await copyText(text, "Finding");
  }

  async _actMute(event, target) {
    const p = P();
    const id = target.dataset.id;
    if (!id) return;
    if (p.muted.has(id)) { p.unmute(id); ui.notifications?.info(`Unmuted ${id}.`); return; }
    p.mute(id);
    ui.notifications?.warn(`${id} is MUTED — watch the FPS readout on the dashboard. Auto-unmute in 3 minutes.`);
    p._raw.setTimeout(() => {
      if (p.muted.has(id)) { p.unmute(id); ui.notifications?.info(`Auto-unmuted ${id}.`); }
    }, 180000);
  }
}

/* ---------------------------------------------------------------------------------------- */
/* Application                                                                                */
/* ---------------------------------------------------------------------------------------- */

export class PerformanceDashboard extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dmm-performance-dashboard",
    classes: ["dmm-pc"],
    tag: "div",
    window: {
      title: "DMM.Dashboard.Title",
      icon: "fa-solid fa-gauge-high",
      resizable: true,
      contentClasses: ["dmm-pc-content"]
    },
    position: { width: 1080, height: 760 },
    actions: {
      tab: PerformanceDashboard.prototype._actTab,
      sort: PerformanceDashboard.prototype._actSort,
      refresh: PerformanceDashboard.prototype._actRefresh,
      toggleLive: PerformanceDashboard.prototype._actToggleLive,
      reset: PerformanceDashboard.prototype._actReset,
      mute: PerformanceDashboard.prototype._actMute,
      unmuteAll: PerformanceDashboard.prototype._actUnmuteAll,
      idle: PerformanceDashboard.prototype._actIdle,
      scanData: PerformanceDashboard.prototype._actScanData,
      scanMemory: PerformanceDashboard.prototype._actScanMemory,
      snapshot: PerformanceDashboard.prototype._actSnapshot,
      clearSnapshots: PerformanceDashboard.prototype._actClearSnapshots,
      export: PerformanceDashboard.prototype._actExport,
      gc: PerformanceDashboard.prototype._actGC,
      copyFindings: PerformanceDashboard.prototype._actCopyFindings,
      config: PerformanceDashboard.prototype._actConfig,
      openFinding: PerformanceDashboard.prototype._actOpenFinding,
      openError: PerformanceDashboard.prototype._actOpenError,
      listenerBaseline: PerformanceDashboard.prototype._actListenerBaseline,
      clearListenerBaseline: PerformanceDashboard.prototype._actClearListenerBaseline,
      copyRetention: PerformanceDashboard.prototype._actCopyRetention,
      copyIndependent: PerformanceDashboard.prototype._actCopyIndependent
    }
  };

  static TAB_LIST = [
    ["overview", "Overview", "fa-gauge-high"],
    ["modules", "Modules", "fa-cubes"],
    ["hooks", "Hooks", "fa-anchor"],
    ["frames", "Frames", "fa-film"],
    ["memory", "Memory", "fa-memory"],
    ["dom", "DOM", "fa-code"],
    ["canvas", "Canvas", "fa-map"],
    ["data", "Data", "fa-database"],
    ["network", "Network", "fa-network-wired"],
    ["timeline", "Timeline", "fa-timeline"],
    ["errors", "Errors", "fa-bug"],
    ["snapshots", "Snapshots", "fa-camera"]
  ];

  constructor(options = {}) {
    super(options);
    this.tab = "overview";
    this.live = true;
    this.sorts = {};
    this.cache = { canvas: null, dom: null, data: null, memory: null, resources: null, rows: [], findings: [], idle: null };
    this.snapshots = [];
    this.busy = null;
    this._timer = null;
    this._renderCost = 0;
  }

  get title() {
    const p = P();
    return `Performance Checker${p?.muted?.size ? ` — ${p.muted.size} MUTED` : ""}`;
  }

  /* -- rendering -------------------------------------------------------------------------- */

  /**
   * Time-to-live cache. The DOM and canvas censuses are not cheap — walking a 60k-node document
   * or a 30k-object scene graph every two seconds would make this profiler a performance problem
   * in its own right. Each census refreshes fast only while you are looking at its tab.
   */
  _ttlCache(key, fn, ttlMs) {
    this._ttl ||= {};
    const e = this._ttl[key];
    const t = performance.now();
    if (e && t - e.t < ttlMs) return e.v;
    const t0 = performance.now();
    const v = fn();
    const cost = performance.now() - t0;
    this._censusCost = (this._censusCost || 0) * 0.7 + cost * 0.3;
    this._ttl[key] = { t, v };
    return v;
  }

  _invalidate() { this._ttl = {}; }

  async _prepareContext() {
    const p = P();
    if (!p) return { broken: true };
    this.cache.resources ||= resourceCensus();
    const domTtl = this.tab === "dom" || this.tab === "overview" ? 3000 : 20000;
    const canvasTtl = this.tab === "canvas" ? 4000 : 30000;
    this.cache.dom = this._ttlCache("dom", domCensus, domTtl);
    this.cache.canvas = this._ttlCache("canvas", canvasCensus, canvasTtl);
    this.cache.rows = scorecard({
      resources: this.cache.resources,
      canvas: this.cache.canvas,
      memory: this.cache.memory
    });
    this.cache.findings = findings({
      rows: this.cache.rows,
      canvas: this.cache.canvas,
      dom: this.cache.dom,
      data: this.cache.data,
      memory: this.cache.memory
    });
    return {};
  }

  async _renderHTML() {
    const t0 = performance.now();
    const p = P();
    if (!p) {
      return `<div class="dmm-fatal"><h2>Probe not installed</h2>
        <p>The instrumentation script did not run. Confirm <code>scripts/dmm-probe.js</code> loaded and that
        the probe mode is not set to <em>off</em>, then reload.</p></div>`;
    }
    const html = `
      ${this._renderToolbar()}
      <nav class="dmm-tabs">${PerformanceDashboard.TAB_LIST.map(([k, label, icon]) =>
        `<button type="button" class="dmm-tab${this.tab === k ? " active" : ""}" data-action="tab" data-tab="${k}"
          aria-pressed="${this.tab === k}"><i class="fa-solid ${icon}"></i> ${label}</button>`).join("")}</nav>
      <section class="dmm-body">${this._renderTab()}</section>
      ${this._renderFooter()}`;
    this._renderCost = performance.now() - t0;
    return html;
  }

  _replaceHTML(result, content) {
    const scroller = content.querySelector(".dmm-body");
    const scrollTop = scroller?.scrollTop ?? 0;
    content.innerHTML = result;
    const newScroller = content.querySelector(".dmm-body");
    if (newScroller) newScroller.scrollTop = scrollTop;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._attachDelegate();
    this._startLive();
  }

  /**
   * Own the click delegation rather than relying solely on ApplicationV2's `actions` dispatch.
   *
   * Two reasons. First, the action map is normalised differently across generations and a
   * dashboard whose tabs silently stop working is worse than useless. Second — and this was the
   * actual failure — the live refresh replaces the entire content subtree every two seconds, so
   * a click that lands during a re-render hits a detached element and is swallowed. Handling
   * pointerdown ourselves lets us both dispatch reliably and suspend the auto-refresh the
   * instant the user starts interacting.
   */
  _attachDelegate() {
    const root = this.element;
    if (!root || root.__dmmDelegated === this) return;
    root.__dmmDelegated = this;

    root.addEventListener("pointerdown", () => { this._lastInteraction = Date.now(); }, { capture: true });

    root.addEventListener("click", (event) => {
      const target = event.target.closest?.("[data-action]");
      if (!target || !root.contains(target)) return;
      const name = target.dataset.action;
      // Prefer the normalised options (ApplicationV2 rewrites bare functions into
      // {handler, buttons}), fall back to the raw static map.
      const handler = this.options?.actions?.[name] ?? PerformanceDashboard.DEFAULT_OPTIONS.actions[name];
      const fn = typeof handler === "function" ? handler : handler?.handler;
      // Not one of ours — e.g. the window frame's own close/minimise controls. Leave it alone,
      // and crucially do not stop propagation, or we would break them.
      if (typeof fn !== "function") return;
      // Claim the event so ApplicationV2's own dispatch cannot fire the same action twice
      // (harmless for a tab switch, actively wrong for a mute toggle).
      if (event.__dmmHandled) return;
      event.__dmmHandled = true;
      event.preventDefault();
      event.stopPropagation();
      this._lastInteraction = Date.now();
      Promise.resolve(fn.call(this, event, target)).catch((err) => {
        console.error(`${MODULE_ID} | action "${name}" failed`, err);
        ui.notifications?.error(`Performance Checker: action "${name}" failed — see console.`);
      });
    }, { capture: true });
  }

  async _onClose(options) {
    this._stopLive();
    return super._onClose?.(options);
  }

  _startLive() {
    this._stopLive();
    if (!this.live) return;
    const raw = P()?._raw?.setTimeout || setTimeout;
    const loop = () => {
      if (!this.rendered || !this.live) return;
      // Never re-render out from under an active interaction: a full innerHTML replacement
      // mid-click detaches the element the click was travelling to.
      const idle = Date.now() - (this._lastInteraction || 0) > 2500;
      if (idle && !this.minimized && document.visibilityState === "visible" && !this.busy) {
        this.render().catch(() => {});
      }
      this._timer = raw(loop, 2000);
    };
    this._timer = raw(loop, 2000);
  }

  _stopLive() {
    if (this._timer) { (P()?._raw?.clearTimeout || clearTimeout)(this._timer); this._timer = null; }
  }

  /* -- chrome ------------------------------------------------------------------------------ */

  _renderToolbar() {
    const p = P();
    const s = p.samples.toArray();
    const last = s[s.length - 1] || {};
    const elapsed = (performance.now() - p.p0) / 60000;
    const fps = last.fps || 0;
    const fpsClass = fps >= 50 ? "good" : fps >= 30 ? "mid" : "bad";
    const heap = last.heap || 0;
    const heapPct = last.heapLimit ? (heap / last.heapLimit) * 100 : 0;
    const heapOk = p.capabilities?.heap !== false;
    const crit = this.cache.findings.filter((f) => f.sev === 3).length;
    const warn = this.cache.findings.filter((f) => f.sev === 2).length;

    return `<header class="dmm-toolbar">
      <div class="dmm-stats">
        <div class="dmm-stat ${fpsClass}"><label>FPS</label><b>${fps ? fps.toFixed(0) : "—"}</b>
          <small>${p.refreshHz} Hz ${p.refreshDetected ? "" : "(assumed)"}</small></div>
        <div class="dmm-stat" ${heapOk ? "" : `title="performance.memory is a Chromium-only API and is not exposed in this browser."`}>
          <label>Heap</label>
          <b>${heapOk ? bytes(heap) : "n/a"}</b>
          <small>${heapOk ? (heapPct ? `${heapPct.toFixed(0)}% of limit` : "no limit reported") : "not available here"}</small></div>
        <div class="dmm-stat"><label>DOM</label><b>${num(last.domNodes)}</b><small>${num(last.listeners)} listeners</small></div>
        <div class="dmm-stat"><label>Session</label><b>${elapsed < 60 ? `${elapsed.toFixed(0)}m` : `${(elapsed / 60).toFixed(1)}h`}</b><small>since reset</small></div>
        <div class="dmm-stat ${crit ? "bad" : warn ? "mid" : "good"}"><label>Findings</label><b>${crit} / ${warn}</b><small>critical / warning</small></div>
      </div>
      <div class="dmm-actions">
        <button type="button" data-action="refresh" title="Recompute now"><i class="fa-solid fa-rotate"></i></button>
        <button type="button" data-action="toggleLive" class="${this.live ? "on" : ""}" title="Auto-refresh every 2s"><i class="fa-solid fa-${this.live ? "pause" : "play"}"></i></button>
        <button type="button" data-action="snapshot" title="Take a snapshot for later comparison"><i class="fa-solid fa-camera"></i></button>
        <button type="button" data-action="export" title="Export everything as JSON"><i class="fa-solid fa-file-export"></i></button>
        <button type="button" data-action="reset" title="Zero all counters and start a fresh measurement window"><i class="fa-solid fa-arrow-rotate-left"></i></button>
        <button type="button" data-action="config" title="Probe configuration"><i class="fa-solid fa-sliders"></i></button>
      </div>
    </header>`;
  }

  _renderFooter() {
    const p = P();
    const oh = (p.overhead.stackMs / Math.max(1, performance.now() - p.p0)) * 100;
    const muted = [...p.muted];
    return `<footer class="dmm-footer">
      ${muted.length ? `<span class="dmm-muted-banner"><i class="fa-solid fa-volume-xmark"></i> Muted: ${muted.map(esc).join(", ")}
        <button type="button" data-action="unmuteAll">Unmute all</button></span>` : ""}
      <span class="dmm-selfcost" title="What this profiler itself costs. If this number is large, distrust the rest.">
        probe ${oh.toFixed(2)}% CPU · ${num(p.overhead.stackCaptures)} stack captures${p.overhead.degraded ? " (sampled)" : ""}
        · render ${this._renderCost.toFixed(0)} ms · census ${(this._censusCost || 0).toFixed(0)} ms
      </span>
      ${this.busy ? `<span class="dmm-busy"><i class="fa-solid fa-spinner fa-spin"></i> ${esc(this.busy)}</span>` : ""}
    </footer>`;
  }

  _renderTab() {
    try {
      switch (this.tab) {
        case "overview": return this._tabOverview();
        case "modules": return this._tabModules();
        case "hooks": return this._tabHooks();
        case "frames": return this._tabFrames();
        case "memory": return this._tabMemory();
        case "dom": return this._tabDom();
        case "canvas": return this._tabCanvas();
        case "data": return this._tabData();
        case "network": return this._tabNetwork();
        case "timeline": return this._tabTimeline();
        case "errors": return this._tabErrors();
        case "snapshots": return this._tabSnapshots();
        default: return "";
      }
    } catch (err) {
      console.error(`${MODULE_ID} | tab render failed`, err);
      return `<div class="dmm-fatal"><h3>Tab failed to render</h3><pre>${esc(err?.stack || err)}</pre></div>`;
    }
  }

  /* ======================================================================================== */
  /* OVERVIEW                                                                                 */
  /* ======================================================================================== */

  _tabOverview() {
    const p = P();
    const s = p.samples.toArray();
    const rows = this.cache.rows.filter((r) => r.id !== "core" && r.id !== "unattributed").slice(0, 8);
    const maxScore = rows[0]?.score || 1;
    const f = this.cache.findings;

    const fpsVals = s.map((x) => x.fps).filter((v) => v > 0);
    const heapVals = s.map((x) => x.heap).filter((v) => v > 0);
    const trend = heapTrend(s);

    return `
    <div class="dmm-grid-2">
      <div class="dmm-card">
        <h3><i class="fa-solid fa-chart-line"></i> Frame rate <small>${fpsVals.length} samples</small></h3>
        ${spark(fpsVals, { min: 0, max: Math.max(60, ...fpsVals), color: "var(--dmm-good)" })}
        <div class="dmm-legend">${fpsVals.length ? `min ${Math.min(...fpsVals).toFixed(0)} · avg ${(fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length).toFixed(0)} · now ${fpsVals[fpsVals.length - 1].toFixed(0)}` : ""}
          · ${num(p.global.droppedFrames)} frames over 33 ms</div>
      </div>
      <div class="dmm-card">
        <h3><i class="fa-solid fa-memory"></i> Heap <small>${trend.valid ? `${bytes(trend.bytesPerHour)}/hr trend` : "gathering data"}</small></h3>
        ${spark(heapVals, { color: trend.valid && trend.bytesPerHour > 8e7 ? "var(--dmm-bad)" : "var(--dmm-accent)" })}
        <div class="dmm-legend">${heapVals.length ? `${bytes(Math.min(...heapVals))} – ${bytes(Math.max(...heapVals))}` : "performance.memory unavailable"}</div>
      </div>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-ranking-star"></i> Highest-impact modules
        <small>composite of CPU share, per-frame cost, long-task contribution, DOM churn, timers, errors</small></h3>
      ${rows.length ? rows.map((r) => `
        <div class="dmm-rank">
          <span class="dmm-rank-name">${esc(r.title)}${r.muted ? ` <em class="dmm-muted-tag">muted</em>` : ""}</span>
          ${bar(r.score, maxScore, `${r.score}`)}
          <span class="dmm-rank-meta">${pct(r.cpuPct)} CPU · ${r.msPerFrame >= 0.01 ? `${r.msPerFrame.toFixed(2)} ms/frame · ` : ""}${num(r.hookCalls)} hook calls</span>
          <button type="button" class="dmm-mini" data-action="mute" data-id="${esc(r.id)}">${r.muted ? "Unmute" : "Mute"}</button>
        </div>`).join("") : `<p class="dmm-empty">No module activity recorded yet. Play for a minute and refresh.</p>`}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-clipboard-list"></i> Findings <small>${f.length} total</small>
        <button type="button" class="dmm-mini" data-action="copyFindings">Copy as text</button></h3>
      <p class="dmm-help">Click any finding to freeze it — the detail opens in its own window with all
      the supporting evidence captured at that instant, so it stops moving while you read it. You can
      open several and compare.</p>
      ${f.length ? f.map((x, i) => `
        <div class="dmm-finding clickable sev-${x.sev}" data-action="openFinding" data-index="${i}"
             title="Open a frozen snapshot of this finding">
          <span class="dmm-finding-head">${sevIcon(x.sev)} <b>${esc(x.title)}</b>
            ${x.owner ? `<code>${esc(x.owner)}</code>` : ""}
            <span class="dmm-metric">${esc(x.metric)}</span>
            <i class="fa-solid fa-up-right-and-down-left-from-center dmm-open-hint"></i></span>
        </div>`).join("") : `<p class="dmm-empty">Nothing flagged. Either the world is healthy or nothing interesting has happened yet — play for a few minutes with the dashboard open, then look again.</p>`}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-stopwatch"></i> Idle churn test</h3>
      <p class="dmm-help">Sit still and touch nothing for the duration. In a healthy world almost nothing should
      happen. Whatever a module does during this window, it does forever — this is the cleanest way to find
      permanent background cost.</p>
      <button type="button" class="dmm-primary" data-action="idle">Run 6-second idle test</button>
      ${this.cache.idle ? this._renderIdle(this.cache.idle) : ""}
    </div>`;
  }

  _renderIdle(r) {
    const rows = r.owners.filter((o) => o.cpuMs > 0.05 || o.callsPerSec > 1 || o.domOpsPerSec > 1);
    return `<div class="dmm-idle">
      <div class="dmm-legend">${r.seconds.toFixed(1)}s idle · ${r.fps.toFixed(0)} FPS · heap ${r.heapDelta >= 0 ? "+" : ""}${bytes(r.heapDelta)} (${bytes(r.heapPerMin)}/min while doing nothing)</div>
      ${table("idle", [
        { key: "owner", label: "Package" },
        { key: "cpuPct", label: "CPU while idle", align: "right", render: (x) => `<b class="${x.cpuPct > 3 ? "dmm-crit" : x.cpuPct > 1 ? "dmm-warn" : ""}">${x.cpuPct.toFixed(2)}%</b>` },
        { key: "cpuMs", label: "ms", align: "right", render: (x) => ms(x.cpuMs) },
        { key: "callsPerSec", label: "calls/s", align: "right", render: (x) => x.callsPerSec.toFixed(0) },
        { key: "domOpsPerSec", label: "DOM ops/s", align: "right", render: (x) => x.domOpsPerSec.toFixed(0) },
        { key: "storagePerSec", label: "storage/s", align: "right", render: (x) => x.storagePerSec.toFixed(1) },
        { key: "dbPerSec", label: "db/s", align: "right", render: (x) => x.dbPerSec.toFixed(1) }
      ], rows, { empty: "Nothing measurable happened while idle. That is the correct answer." })}
      <h4>Hooks still firing while idle</h4>
      ${table("idlehooks", [
        { key: "hook", label: "Hook" },
        { key: "owner", label: "Package" },
        { key: "perSec", label: "per second", align: "right", render: (x) => x.perSec.toFixed(1) }
      ], r.hooks, { empty: "No hooks fired." })}
    </div>`;
  }

  /* ======================================================================================== */
  /* MODULES                                                                                  */
  /* ======================================================================================== */

  _tabModules() {
    const sort = this.sorts.modules || { key: "score", dir: -1 };
    const rows = sortRows(this.cache.rows, sort);
    const p = P();
    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-cubes"></i> Per-package cost
        <small>measured over ${((performance.now() - p.p0) / 60000).toFixed(1)} minutes</small></h3>
      <p class="dmm-help"><b>Mute</b> turns a package's hook callbacks, timers, listeners, ticker callbacks and
      libWrapper wrappers into no-ops immediately — no reload, no re-login. Watch the FPS readout for 20–30 seconds,
      then unmute. It is a diagnostic, not a fix: muted modules will misbehave until you unmute, so do not do this
      mid-combat and expect automation to work.</p>
      ${table("modules", [
        { key: "title", label: "Package", render: (r) => `<span class="dmm-pkg${r.muted ? " muted" : ""}">${esc(r.title)}<small>${esc(r.id)}${r.installed ? "" : " · not installed"}</small></span>` },
        { key: "score", label: "Impact", align: "right", render: (r) => `<b class="${r.score > 30 ? "dmm-crit" : r.score > 12 ? "dmm-warn" : ""}">${r.score}</b>` },
        { key: "cpuPct", label: "CPU %", align: "right", render: (r) => pct(r.cpuPct) },
        { key: "cpuMs", label: "CPU time", align: "right", render: (r) => ms(r.cpuMs) },
        { key: "msPerFrame", label: "ms/frame", align: "right", render: (r) => (r.msPerFrame >= 0.005 ? r.msPerFrame.toFixed(2) : "—") },
        { key: "hookCalls", label: "Hook calls", align: "right", render: (r) => num(r.hookCalls) },
        { key: "hookMax", label: "Worst call", align: "right", render: (r) => (r.hookMax ? `${ms(r.hookMax)}<small>${esc(r.hookMaxName)}</small>` : "—") },
        { key: "lwSelf", label: "libWrapper", align: "right", render: (r) => (r.lwCalls ? `${ms(r.lwSelf)}<small>${ms(r.lwInclusive)} enveloped</small>` : "—") },
        { key: "liveIntervals", label: "Timers", align: "right", render: (r) => (r.liveIntervals || r.intervalRegs ? `${r.liveIntervals}<small>${r.intervalRegs} created</small>` : "—") },
        { key: "listenerRegs", label: "Listeners", align: "right", render: (r) => num(r.listenerRegs) },
        { key: "domOps", label: "DOM ops", align: "right", render: (r) => num(r.domOps) },
        { key: "dbDocs", label: "DB writes", align: "right", render: (r) => num(r.dbDocs) },
        { key: "errors", label: "Errors", align: "right", render: (r) => (r.errors ? `<b class="dmm-crit">${r.errors}</b>` : "—") },
        { key: "assetBytes", label: "Payload", align: "right", render: (r) => (r.assetBytes ? bytes(r.assetBytes) : "—") },
        { key: "retainedBytes", label: "Retained", align: "right", render: (r) => (r.retainedBytes ? `${bytes(r.retainedBytes)}${r.retainedTruncated ? "+" : ""}` : "—") },
        { key: "id", label: "", align: "right", render: (r) => (r.id === "core" || r.id === "unattributed" ? "" : `<button type="button" class="dmm-mini" data-action="mute" data-id="${esc(r.id)}">${r.muted ? "Unmute" : "Mute"}</button>`) }
      ], rows, { sort, rowClass: (r) => (r.muted ? "muted-row" : r.id === "core" ? "core-row" : "") })}
      <p class="dmm-help"><b>Retained</b> is a bounded object-graph estimate of what each module holds on its public
      API surface — a proxy, not a heap measurement. Press <button type="button" class="dmm-mini" data-action="scanMemory">Scan retained memory</button>
      to compute it (it walks a lot of objects and will hitch for a second).</p>
    </div>`;
  }

  /* ======================================================================================== */
  /* HOOKS                                                                                    */
  /* ======================================================================================== */

  _tabHooks() {
    const p = P();
    const sort = this.sorts.hooks || { key: "total", dir: -1 };
    const elapsedMin = (performance.now() - p.p0) / 60000;
    const rows = sortRows(
      [...p.hooks.values()]
        .filter((h) => h.calls > 0 || h.live > 0)
        .map((r) => ({ ...r, perMin: r.calls / Math.max(0.01, elapsedMin), avg: r.calls ? r.total / r.calls : 0 })),
      sort
    ).slice(0, 400);
    const env = [...p.hookEnvelope.values()].sort((a, b) => b.total - a.total).slice(0, 30);

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-anchor"></i> Hook callbacks by cost</h3>
      <p class="dmm-help">One row per (hook, package) pair. <b>Self</b> excludes time spent inside nested
      instrumented calls, so a module that merely triggers other modules' work is not blamed for it.
      Sort by <b>calls/min</b> to find hooks that fire far more often than they should.</p>
      ${table("hooks", [
        { key: "hook", label: "Hook" },
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "calls", label: "Calls", align: "right", render: (r) => num(r.calls) },
        { key: "perMin", label: "Calls/min", align: "right", render: (r) => num(r.calls / Math.max(0.01, elapsedMin)) },
        { key: "total", label: "Total", align: "right", render: (r) => ms(r.total) },
        { key: "self", label: "Self", align: "right", render: (r) => ms(r.self) },
        { key: "avg", label: "Avg", align: "right", render: (r) => (r.calls ? ms(r.total / r.calls) : "—") },
        { key: "max", label: "Worst", align: "right", render: (r) => `<span class="${r.max > 50 ? "dmm-crit" : r.max > 16 ? "dmm-warn" : ""}">${ms(r.max)}</span>` },
        { key: "live", label: "Live regs", align: "right" },
        { key: "errors", label: "Err", align: "right", render: (r) => (r.errors ? `<b class="dmm-crit">${r.errors}</b>` : "—") },
        { key: "muted", label: "Muted", align: "right", render: (r) => (r.muted ? num(r.muted) : "—") }
      ], rows, { sort })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-bolt"></i> Hook fire rate <small>whole-hook envelope, all listeners</small></h3>
      <p class="dmm-help">Which hooks Foundry fires most, and what a full dispatch costs. A hook firing thousands of
      times per minute is a design smell regardless of who listens to it.</p>
      ${table("env", [
        { key: "hook", label: "Hook" },
        { key: "calls", label: "Fires", align: "right", render: (r) => num(r.calls) },
        { key: "perMin", label: "Fires/min", align: "right", render: (r) => num(r.calls / Math.max(0.01, elapsedMin)) },
        { key: "total", label: "Total dispatch", align: "right", render: (r) => ms(r.total) },
        { key: "max", label: "Worst dispatch", align: "right", render: (r) => ms(r.max) }
      ], env.map((r) => ({ ...r, perMin: r.calls / Math.max(0.01, elapsedMin) })))}
    </div>

    ${p.libWrapper.size ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-layer-group"></i> libWrapper wrappers</h3>
      <p class="dmm-help"><b>Own</b> is the wrapper's exclusive cost — its own code, with the downstream chain
      subtracted. <b>Enveloped</b> is everything that ran inside it, including the original core function.
      Only <b>Own</b> is charged to the package, and the difference between the two columns is the point:
      a pure pass-through wrapper on a hot function shows a colossal envelope and a trivial own cost, and it is
      not the problem. libWrapper itself wraps <code>Application.prototype._render</code> exactly this way to catch
      render errors, so its envelope is the total cost of every application render this session.</p>
      <p class="dmm-help">Wrapper <b>depth</b> matters separately: each layer adds a call frame to every invocation
      of the wrapped function, so a deeply-stacked hot target is a cost in its own right.</p>
      ${table("lw", [
        { key: "target", label: "Wrapped target" },
        { key: "depth", label: "Depth", align: "right" },
        { key: "owners", label: "Packages" },
        { key: "calls", label: "Calls", align: "right", render: (r) => num(r.calls) },
        { key: "self", label: "Own", align: "right", render: (r) => `<b>${ms(r.self)}</b>` },
        { key: "inclusive", label: "Enveloped", align: "right", render: (r) => `<span class="dmm-dim">${ms(r.inclusive)}</span>` },
        { key: "ratio", label: "Own share", align: "right", render: (r) => `${r.ratio.toFixed(1)}%` },
        { key: "maxSelf", label: "Worst own", align: "right", render: (r) => ms(r.maxSelf) }
      ], [...p.libWrapper.entries()].map(([target, list]) => {
        const self = list.reduce((a, b) => a + b.self, 0);
        const inclusive = list.reduce((a, b) => a + b.inclusive, 0);
        return {
          target,
          depth: list.length,
          owners: [...new Set(list.map((l) => l.owner))].join(", "),
          calls: list.reduce((a, b) => a + b.calls, 0),
          self, inclusive,
          ratio: inclusive > 0 ? (self / inclusive) * 100 : 0,
          maxSelf: Math.max(0, ...list.map((l) => l.maxSelf))
        };
      }).sort((a, b) => b.self - a.self).slice(0, 60), { sort: this.sorts.lw })}
    </div>` : ""}`;
  }

  /* ======================================================================================== */
  /* FRAMES                                                                                   */
  /* ======================================================================================== */

  _tabFrames() {
    const p = P();
    const frames = p.frames.toArray();
    const sorted = [...frames].sort((a, b) => a - b);
    const q = (x) => (sorted.length ? sorted[Math.floor(sorted.length * x)] : 0);
    const ticker = [...p.ticker.values()].sort((a, b) => b.total - a.total);
    const totalFrames = p.global.frames || 1;
    const allInputs = (p.inputLatency?.toArray() || []).slice(-60).reverse();
    const inputs = allInputs.filter((i) => i.discrete);
    const hover = allInputs.filter((i) => !i.discrete);

    // Frame time histogram, bucketed against this display's actual vsync interval rather than
    // an assumed 60 Hz one.
    const B = p.frameBudgetMs || 16.67;
    const mult = [0.5, 0.75, 1, 1.2, 1.5, 2, 3, 6, 15, Infinity];
    const buckets = mult.map((m) => (isFinite(m) ? B * m : Infinity));
    const labels = mult.map((m, i) => {
      if (!isFinite(m)) return `>${(B * mult[i - 1]).toFixed(0)}`;
      const lo = i === 0 ? 0 : B * mult[i - 1];
      return `${lo.toFixed(lo < 10 ? 1 : 0)}–${(B * m).toFixed(B * m < 10 ? 1 : 0)}`;
    });
    const counts = new Array(buckets.length).fill(0);
    for (const f of frames) { for (let i = 0; i < buckets.length; i++) if (f < buckets[i]) { counts[i]++; break; } }
    const maxCount = Math.max(1, ...counts);

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-film"></i> Frame time distribution
        <small>last ${frames.length} frames · ${p.refreshHz} Hz ${p.refreshDetected ? "detected" : "assumed"}, budget ${B.toFixed(1)} ms</small></h3>
      <div class="dmm-hist">${counts.map((c, i) => `
        <div class="dmm-hist-col" title="${c} frames">
          <div class="dmm-hist-bar ${buckets[i] > B * 2 ? "bad" : buckets[i] > B ? "mid" : "good"}" style="height:${(c / maxCount) * 100}%"></div>
          <label>${labels[i]}</label>
        </div>`).join("")}</div>
      <div class="dmm-legend">p50 ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms · p99 ${q(0.99).toFixed(1)} ms · worst ${(sorted[sorted.length - 1] || 0).toFixed(0)} ms
        — above ${B.toFixed(1)} ms is a missed frame on your display.</div>
      ${spark(frames.slice(-600), { h: 60, max: Math.min(B * 8, Math.max(...frames, B * 2)), color: "var(--dmm-warn)" })}
      ${p.refreshHz > 90 ? `<p class="dmm-help">Your display runs at ${p.refreshHz} Hz, so the frame budget is
      <b>${B.toFixed(1)} ms</b>, not the 16.7 ms most Foundry performance advice assumes. A module costing 2 ms/frame
      is using ${((2 / B) * 100).toFixed(0)}% of your budget rather than 12%. High refresh rates make module cost
      hurt sooner, not later.</p>` : ""}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-arrows-rotate"></i> Per-frame work by package <small>PIXI ticker callbacks</small></h3>
      <p class="dmm-help">These run on <em>every frame</em>. Multiply ms/frame by 60 to get the per-second tax.
      This is where canvas-heavy modules show their true cost.</p>
      ${table("ticker", [
        { key: "owner", label: "Package" },
        { key: "live", label: "Callbacks", align: "right" },
        { key: "calls", label: "Invocations", align: "right", render: (r) => num(r.calls) },
        { key: "perFrame", label: "ms/frame", align: "right", render: (r) => `<b class="${r.pctFrame > 8 ? "dmm-crit" : r.pctFrame > 2.5 ? "dmm-warn" : ""}">${r.perFrame.toFixed(3)}</b>` },
        { key: "pctFrame", label: `% of ${p.frameBudgetMs.toFixed(1)} ms budget`, align: "right", render: (r) => pct(r.pctFrame) },
        { key: "total", label: "Total", align: "right", render: (r) => ms(r.total) },
        { key: "max", label: "Worst", align: "right", render: (r) => ms(r.max) },
        { key: "fns", label: "Functions", render: (r) => `<small>${esc([...r.fnsMap.entries()].slice(0, 4).map(([n, c]) => `${n}×${c}`).join(", "))}</small>` }
      ], ticker.map((t) => ({
        ...t, fnsMap: t.fns,
        perFrame: t.total / totalFrames,
        pctFrame: (t.total / totalFrames / (p.frameBudgetMs || 16.67)) * 100
      })), { empty: "No ticker callbacks recorded. Either the canvas is not up, or PIXI was patched too late." })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-hand-pointer"></i> Discrete input responsiveness <small>clicks and key presses over 40 ms</small></h3>
      <p class="dmm-help">These are the only entries that reliably mean "the UI felt slow". The total splits into
      <b>Queued</b> (browser was busy — blame long tasks), <b>Handler</b> (a listener did real work — blame the module),
      and <b>Paint</b> (waiting for the next frame — blame canvas or layout cost). They have different fixes, so the
      split matters more than the total.</p>
      ${table("input", [
        { key: "name", label: "Event" },
        { key: "dur", label: "Total", align: "right", render: (r) => `<b class="${r.dur > 200 ? "dmm-crit" : r.dur > 100 ? "dmm-warn" : ""}">${ms(r.dur)}</b>` },
        { key: "delay", label: "Queued", align: "right", render: (r) => ms(r.delay) },
        { key: "processing", label: "Handler", align: "right", render: (r) => `<b class="${r.processing > 80 ? "dmm-crit" : r.processing > 30 ? "dmm-warn" : ""}">${ms(r.processing)}</b>` },
        { key: "present", label: "Paint", align: "right", render: (r) => ms(r.present) },
        { key: "t", label: "When", align: "right", render: (r) => new Date(r.t).toLocaleTimeString() }
      ], inputs, { empty: "No slow discrete interactions recorded. That is the good outcome." })}
    </div>

    ${hover.length ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-arrow-pointer"></i> Hover and move events <small>usually not real lag</small></h3>
      <p class="dmm-help">The Event Timing API measures from the input timestamp to the <em>next paint</em>, rounded up
      to 8 ms. For continuous events on a constantly-rendering canvas that total is mostly "when did Foundry next
      repaint", which is not latency. Only the <b>Handler</b> column here is meaningful — if it is small, these numbers
      are an artefact, not a problem. They are shown separately for exactly that reason.</p>
      ${table("hoverinput", [
        { key: "name", label: "Event" },
        { key: "dur", label: "Total", align: "right", render: (r) => ms(r.dur) },
        { key: "processing", label: "Handler", align: "right", render: (r) => `<b class="${r.processing > 30 ? "dmm-warn" : ""}">${ms(r.processing)}</b>` },
        { key: "present", label: "Paint wait", align: "right", render: (r) => ms(r.present) },
        { key: "t", label: "When", align: "right", render: (r) => new Date(r.t).toLocaleTimeString() }
      ], hover.slice(0, 25))}
    </div>` : ""}`;
  }

  /* ======================================================================================== */
  /* MEMORY                                                                                   */
  /* ======================================================================================== */

  _tabMemory() {
    const p = P();
    const s = p.samples.toArray();
    const m = this.cache.memory;
    const trend = heapTrend(s);
    const dl = drift(s, "listeners"), dn = drift(s, "domNodes"), dc = drift(s, "canvasObjects");

    return `
    ${p.capabilities?.heap === false ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-circle-info"></i> Heap measurement is unavailable in this browser</h3>
      <p class="dmm-help"><code>performance.memory</code> is a non-standard Chromium API. It is not exposed in
      ${p.capabilities.engine === "firefox" ? "Firefox" : "this browser"}, so heap size, the post-GC floor trend and
      heap-based leak detection are all unavailable. <b>An empty heap chart here means "no data", not "no leak".</b></p>
      <p class="dmm-help">The <b>Growth indicators</b> below do not depend on it and remain fully valid — a leak
      almost always shows up there too, as a counter that only climbs. For the heap number specifically, run one
      session in the Foundry desktop client or Chrome.</p>
    </div>` : ""}

    <div class="dmm-card">
      <h3><i class="fa-solid fa-memory"></i> Heap over the session</h3>
      ${spark(s.map((x) => x.heap).filter(Boolean), { h: 70 })}
      <div class="dmm-legend">
        ${trend.valid
          ? `Post-GC floor trend: <b class="${trend.bytesPerHour > 2.5e8 ? "dmm-crit" : trend.bytesPerHour > 8e7 ? "dmm-warn" : ""}">${bytes(trend.bytesPerHour)}/hour</b>
             (floor ${bytes(trend.floorStart)} → ${bytes(trend.floorEnd)} over ${trend.spanMinutes.toFixed(0)} min)`
          : "Need a few more minutes of samples to establish a trend."}
        ${m?.heap ? ` · now ${bytes(m.heap.used)} of ${bytes(m.heap.limit)} (${m.heap.pctOfLimit.toFixed(0)}%)` : ""}
      </div>
      <p class="dmm-help">Raw heap sawtooths with garbage collection; the number that matters is whether the
      <em>floor</em> rises. A rising floor means something is retained that should not be. Buttons below force a
      collection where the browser allows it, which sharpens the signal.</p>
      <button type="button" class="dmm-mini" data-action="gc">Request GC</button>
      <button type="button" class="dmm-mini" data-action="scanMemory">Scan retained memory</button>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-chart-line"></i> Growth indicators <small>first third vs last third of session</small></h3>
      <p class="dmm-help">A leak always shows up as a counter that only goes up. This table names which one.</p>
      ${table("growth", [
        { key: "name", label: "Counter" },
        { key: "early", label: "Early", align: "right", render: (r) => num(r.early) },
        { key: "late", label: "Late", align: "right", render: (r) => num(r.late) },
        { key: "delta", label: "Change", align: "right", render: (r) => `<b class="${r.pct > 50 ? "dmm-crit" : r.pct > 20 ? "dmm-warn" : ""}">${r.delta >= 0 ? "+" : ""}${num(r.delta)} (${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%)</b>` }
      ], [
        drift(s, "listenersAttached") && { name: "Listeners still attached to the document", ...drift(s, "listenersAttached") },
        dl && { name: "Listener registrations not explicitly removed (not a leak signal)", ...dl },
        dn && { name: "DOM elements", ...dn },
        dc && { name: "Canvas display objects", ...dc },
        drift(s, "chatDom") && { name: "Chat messages in DOM", ...drift(s, "chatDom") },
        drift(s, "intervals") && { name: "Live setInterval handles", ...drift(s, "intervals") },
        drift(s, "apps") && { name: "Open application instances", ...drift(s, "apps") }
      ].filter(Boolean), { empty: "Not enough samples yet — leave the dashboard open for 10+ minutes." })}
    </div>

    ${m ? `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-box-archive"></i> Retained by module API <small>bounded object-graph estimate</small></h3>
      ${table("retained", [
        { key: "title", label: "Module", render: (r) => `<span class="dmm-pkg">${esc(r.title || r.id)}<small>${esc(r.id)}</small></span>` },
        { key: "bytes", label: "Estimated", align: "right", render: (r) => `${bytes(r.bytes)}${r.truncated ? "+" : ""}` },
        { key: "nodes", label: "Objects walked", align: "right", render: (r) => num(r.nodes) },
        { key: "parts", label: "Where" }
      ], (m.modules || []).slice(0, 40), { empty: "No module exposes an inspectable API surface." })}
      <p class="dmm-help">Only counts what a module hangs off <code>module.api</code> / <code>module.instance</code>.
      A module can hold plenty in closures this cannot see — treat a large number as evidence, a small number as
      no evidence either way.</p>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-globe"></i> Globals created after load</h3>
      ${table("globals", [
        { key: "key", label: "Global" },
        { key: "guess", label: "Likely owner", render: (r) => (r.guess ? `<code>${esc(r.guess)}</code>` : "<small>unknown</small>") },
        { key: "type", label: "Type" },
        { key: "bytes", label: "Estimated", align: "right", render: (r) => `${bytes(r.bytes)}${r.truncated ? "+" : ""}` }
      ], (m.newGlobals || []).slice(0, 30), { empty: "None." })}
    </div>` : `<div class="dmm-card"><p class="dmm-empty">Retained-memory scan not run yet.
      <button type="button" class="dmm-primary" data-action="scanMemory">Scan now</button></p></div>`}`;
  }

  /* ======================================================================================== */
  /* DOM                                                                                      */
  /* ======================================================================================== */

  _tabDom() {
    const d = this.cache.dom;
    const p = P();
    const elapsedMin = (performance.now() - p.p0) / 60000;
    const listeners = [...p.listeners.values()].sort((a, b) => b.attached - a.attached || b.live - a.live).slice(0, 60);
    const churn = this.cache.rows.filter((r) => r.domOps > 0).sort((a, b) => b.domOps - a.domOps).slice(0, 25);

    return `
    <div class="dmm-grid-3">
      <div class="dmm-card mini"><label>Elements</label><b>${num(d.total)}</b><small>max depth ${d.depth}${d.detachedWindows?.length ? ` · incl. ${num(d.detachedWindows.reduce((a, w) => a + w.nodes, 0))} in pop-outs` : ""}</small></div>
      <div class="dmm-card mini"><label>Chat log</label><b>${num(d.chat.domMessages)}</b><small>${num(d.chat.nodes)} nodes · ${d.chat.nodesPerMessage}/msg</small></div>
      <div class="dmm-card mini"><label>Open apps</label><b>${num(d.apps.open)}</b><small>${d.apps.list.filter((a) => a.orphaned).length} orphaned${d.detachedWindows?.length ? ` · ${d.detachedWindows.length} pop-out` : ""}</small></div>
      <div class="dmm-card mini"><label>CSS rules</label><b>${num(d.cssRules)}</b><small>${d.styleSheets} sheets</small></div>
      <div class="dmm-card mini"><label>Inline styles</label><b>${num(d.inlineStyles)}</b><small>elements with style=</small></div>
      <div class="dmm-card mini"><label>Media</label><b>${num(d.images + d.videos)}</b><small>${d.images} img · ${d.videos} video · ${d.canvases} canvas</small></div>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-diagram-project"></i> Where the DOM weight is</h3>
      ${table("region", [
        { key: "sel", label: "Region" },
        { key: "nodes", label: "Elements", align: "right", render: (r) => num(r.nodes) },
        { key: "share", label: "", render: (r) => bar(r.nodes, d.total, `${((r.nodes / Math.max(1, d.total)) * 100).toFixed(0)}%`) }
      ], d.byRegion)}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-pen-to-square"></i> DOM churn by package</h3>
      <p class="dmm-help">Counted at <code>appendChild</code> / <code>insertBefore</code> / <code>removeChild</code> /
      <code>innerHTML</code>, attributed to whichever package's callback was on the stack. High churn means repeated
      style recalculation and layout — sluggish UI even when the canvas is smooth.</p>
      ${table("churn", [
        { key: "title", label: "Package", render: (r) => `<span class="dmm-pkg">${esc(r.title)}<small>${esc(r.id)}</small></span>` },
        { key: "domOps", label: "Mutations", align: "right", render: (r) => num(r.domOps) },
        { key: "domOpsPerMin", label: "Per minute", align: "right", render: (r) => num(r.domOpsPerMin) },
        { key: "domHtmlChars", label: "innerHTML written", align: "right", render: (r) => (r.domHtmlChars ? bytes(r.domHtmlChars * 2) : "—") },
        { key: "storageWrites", label: "localStorage writes", align: "right", render: (r) => (r.storageWrites ? `${num(r.storageWrites)} <small>${bytes(r.storageBytes)}</small>` : "—") }
      ], churn)}
    </div>

    ${this._renderObservers(p, elapsedMin)}

    ${this._renderRetention(p)}

    <div class="dmm-card">
      <h3><i class="fa-solid fa-ear-listen"></i> Event listeners
        ${p.listenerCoverage < 0.98 ? `<small class="dmm-warn">tracking ${(p.listenerCoverage * 100).toFixed(0)}% of registrations (${num(p.listenerUntracked)} beyond the WeakRef budget)</small>` : ""}</h3>
      <p class="dmm-help"><b>Attached</b> is the column that matters: registrations whose target is still connected
      to the document. <b>Not removed</b> is added-minus-<code>removeEventListener</code>, which in Foundry is not a
      leak signal at all — applications throw their whole element away on close without removing listeners, so
      opening and closing a single character sheet can add thousands to that number permanently while retaining
      nothing. If <b>Attached</b> is flat while <b>Not removed</b> climbs, everything is being collected normally.
      A rising <b>Attached</b> — especially on <code>window</code> or <code>document</code> targets, which survive an
      application close — is a real leak.</p>
      ${table("listeners", [
        { key: "type", label: "Event" },
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "attached", label: "Attached", align: "right", render: (r) => `<b class="${r.attached > 400 ? "dmm-crit" : r.attached > 120 ? "dmm-warn" : ""}">${num(r.attached)}</b>${r.untracked ? `<small>+${num(r.untracked)} untracked</small>` : ""}` },
        { key: "live", label: "Not removed", align: "right", render: (r) => `<span class="dmm-dim">${num(r.live)}</span>` },
        { key: "orphaned", label: "Collected", align: "right", render: (r) => `<span class="dmm-dim">${num(r.orphaned)}</span>` },
        { key: "regs", label: "Added", align: "right", render: (r) => num(r.regs) },
        { key: "calls", label: "Fired", align: "right", render: (r) => num(r.calls) },
        { key: "perMin", label: "Fired/min", align: "right", render: (r) => num(r.calls / Math.max(0.01, elapsedMin)) },
        { key: "total", label: "Total", align: "right", render: (r) => ms(r.total) },
        { key: "max", label: "Worst", align: "right", render: (r) => ms(r.max) },
        { key: "targets", label: "Attached to", render: (r) => `<small>${esc([...r.targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}×${n}`).join(", "))}</small>` }
      ], listeners.map((l) => ({ ...l })))}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-window-restore"></i> Application instances</h3>
      ${table("apps", [
        { key: "cls", label: "Class" },
        { key: "id", label: "Id" },
        { key: "nodes", label: "Elements", align: "right", render: (r) => num(r.nodes) },
        { key: "orphaned", label: "State", render: (r) => (r.orphaned ? `<b class="dmm-crit">orphaned</b>` : r.poppedOut ? `popped out` : "attached") }
      ], d.apps.list)}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-weight-hanging"></i> Heaviest subtrees</h3>
      ${table("heavy", [
        { key: "tag", label: "Element" },
        { key: "id", label: "#id" },
        { key: "cls", label: "class" },
        { key: "nodes", label: "Elements", align: "right", render: (r) => num(r.nodes) }
      ], d.heavySubtrees)}
    </div>`;
  }

  /**
   * The controlled experiment for "are listeners actually leaking?".
   *
   * Counting listeners at one moment tells you nothing, because you cannot know what should
   * have been cleaned up. Marking a baseline and performing a known reversible action — open a
   * sheet, close it — turns it into a falsifiable test: whatever is still attached afterwards
   * genuinely survived, and the per-target breakdown says what it survived on.
   */
  /**
   * MutationObserver / ResizeObserver / IntersectionObserver, plus requestIdleCallback.
   *
   * These are scheduled by the browser rather than by the module, so nothing on the context
   * stack identifies the owner and before this they all landed in `unattributed`. Attribution
   * is taken at construction, where the registering package is still on the stack.
   */
  _renderObservers(p, elapsedMin) {
    const rows = [...(p.observers?.values?.() || [])].filter((r) => r.calls || r.live);
    const idle = [...p.owners.values()].filter((o) => o.idleCalls > 0);
    if (!rows.length && !idle.length) return "";
    rows.sort((a, b) => b.total - a.total);
    return `<div class="dmm-card">
      <h3><i class="fa-solid fa-binoculars"></i> Observers and idle callbacks</h3>
      <p class="dmm-help">A <code>MutationObserver</code> watching a busy subtree, or a
      <code>ResizeObserver</code> that writes layout back from its own callback, is a common cause of jank that
      no amount of hook or ticker instrumentation will explain — the browser schedules these, so they never
      appear on the stack of whatever triggered them. <b>Records</b> is how much the browser had to hand the
      callback; a high records-per-call means the observer is watching far more than it needs to.</p>
      ${table("observers", [
        { key: "kind", label: "Observer" },
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "live", label: "Live", align: "right", render: (r) => `${num(r.live)}<small>of ${num(r.constructed)}</small>` },
        { key: "calls", label: "Fired", align: "right", render: (r) => num(r.calls) },
        { key: "perMin", label: "Fired/min", align: "right", render: (r) => num(r.calls / Math.max(0.01, elapsedMin)) },
        { key: "records", label: "Records", align: "right", render: (r) => `${num(r.records)}<small>${r.calls ? (r.records / r.calls).toFixed(1) : "0"}/call</small>` },
        { key: "total", label: "Total", align: "right", render: (r) => ms(r.total) },
        { key: "max", label: "Worst", align: "right", render: (r) => `<b class="${r.max > 16 ? "dmm-crit" : r.max > 4 ? "dmm-warn" : ""}">${ms(r.max)}</b>` }
      ], rows)}
      ${idle.length ? `<h4 style="margin-top:10px">requestIdleCallback</h4>
      ${table("idlecb", [
        { key: "id", label: "Package", render: (r) => `<code>${esc(r.id)}</code>` },
        { key: "idleRegs", label: "Scheduled", align: "right", render: (r) => num(r.idleRegs) },
        { key: "idleCalls", label: "Ran", align: "right", render: (r) => num(r.idleCalls) },
        { key: "idleTotal", label: "Total", align: "right", render: (r) => ms(r.idleTotal) }
      ], idle.map((o) => ({ id: o.id, idleRegs: o.idleRegs, idleCalls: o.idleCalls, idleTotal: o.idleTotal })))}` : ""}
    </div>`;
  }

  _renderRetention(p) {
    const delta = p.listenerDelta?.();
    return `<div class="dmm-card dmm-retention">
      <h3><i class="fa-solid fa-flask"></i> Listener retention test</h3>
      <p class="dmm-help">A single listener count means nothing on its own — you cannot tell what
      <em>should</em> have been released. Instead: mark a baseline, open a sheet, close it, and read the delta.
      Anything still attached after the close genuinely survived it.</p>
      <ol class="dmm-steps">
        <li>Press <b>Mark baseline</b> with nothing open.</li>
        <li>Open the sheet or window you suspect, then close it again. Repeat 2–3 times to make the signal obvious.</li>
        <li>Read the table below. <b>Added</b> is registrations since the baseline; <b>Still attached</b> is how many
        of them are on a target that is still in the document.</li>
      </ol>
      <p class="dmm-help"><b>Still attached ≈ 0</b> with a large Added → nothing is leaking; the elements were
      discarded normally and the raw registration counter is simply the wrong thing to watch.
      <b>Still attached ≈ Added</b> → a real leak, and the <b>Attached to</b> column names the surviving target.
      Listeners on <code>window</code> or <code>document</code> are the usual culprits, because those outlive
      any application.</p>
      <div class="dmm-detail-buttons">
        <button type="button" class="dmm-primary" data-action="listenerBaseline">${p.listenerBaseline ? "Re-mark baseline" : "Mark baseline"}</button>
        ${p.listenerBaseline ? `<button type="button" class="dmm-mini" data-action="clearListenerBaseline">Clear</button>` : ""}
        ${delta ? `<button type="button" class="dmm-mini" data-action="copyRetention">Copy result</button>` : ""}
      </div>
      ${delta ? `
        <div class="dmm-legend">Baseline ${(delta.sinceMs / 1000).toFixed(0)}s ago ·
          net change in attached listeners: <b class="${delta.totalAttachedDelta > 200 ? "dmm-crit" : delta.totalAttachedDelta > 50 ? "dmm-warn" : "dmm-good-text"}">${delta.totalAttachedDelta >= 0 ? "+" : ""}${num(delta.totalAttachedDelta)}</b></div>
        ${table("retention", [
          { key: "type", label: "Event" },
          { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
          { key: "regsDelta", label: "Added", align: "right", render: (r) => num(r.regsDelta) },
          { key: "attachedDelta", label: "Still attached", align: "right", render: (r) => `<b class="${r.attachedDelta > 100 ? "dmm-crit" : r.attachedDelta > 20 ? "dmm-warn" : ""}">${r.attachedDelta >= 0 ? "+" : ""}${num(r.attachedDelta)}</b>` },
          { key: "retainedRatio", label: "Retained", align: "right", render: (r) => (r.regsDelta > 0 ? `${(r.retainedRatio * 100).toFixed(0)}%` : "—") },
          { key: "attachedBy", label: "Attached to", render: (r) => `<small>${esc((r.attachedBy || []).map(([l, n2]) => `${l}×${n2}`).join(", ") || "—")}</small>` },
          { key: "verdict", label: "", render: (r) => (r.regsDelta > 20 && r.retainedRatio < 0.1
            ? `<span class="dmm-good-text">released</span>`
            : r.retainedRatio > 0.7 && r.attachedDelta > 20 ? `<b class="dmm-crit">retained</b>` : "") }
        ], delta.rows.slice(0, 30), { empty: "Nothing changed since the baseline." })}
        ${delta.rows.some((r) => r.retainedRatio > 0.7 && r.attachedDelta > 20) ? `
          <h4>Where the surviving listeners were registered</h4>
          ${delta.rows.filter((r) => r.retainedRatio > 0.7 && r.attachedDelta > 20).slice(0, 4).map((r) => `
            <div class="dmm-err-block"><b>${esc(r.owner)}</b> — <code>${esc(r.type)}</code>
              <small>${esc((r.attachedBy || []).map(([l, n2]) => `${l}×${n2}`).join(", "))}</small>
              <pre class="dmm-stack">${esc((r.stacks || []).map(([l, st]) => `${l}\n${st}`).join("\n\n") || "(no stack captured)")}</pre>
            </div>`).join("")}` : ""}
      ` : `<p class="dmm-empty">No baseline marked yet.</p>`}

      <details class="dmm-independent">
        <summary><i class="fa-solid fa-scale-balanced"></i> Check this without trusting my counters</summary>
        <p class="dmm-help">Reasonable thing to want, given this panel depends on my bookkeeping being right.
        The snippet below shares no code with this module: it patches <code>addEventListener</code> fresh and tallies
        net add-minus-remove per target kind. Paste it into the console (F12 → Console), note
        <code>__ltNodes()</code>, open and close the sheet, then run <code>__lt()</code> and <code>__ltNodes()</code>
        again. <code>__ltStop()</code> undoes it.</p>
        <p class="dmm-help">Rows with target <b>element</b> climbing are expected — those elements are discarded on
        close. Rows with target <b>window</b>, <b>document</b> or <b>body</b> climbing are the genuine leak, because
        those targets outlive any application. If the node count returns to its starting value, the sheet's DOM was
        removed and its listeners went with it.</p>
        <button type="button" class="dmm-mini" data-action="copyIndependent">Copy snippet</button>
        <pre class="dmm-stack tall">${esc(INDEPENDENT_CHECK)}</pre>
        <p class="dmm-help"><b>In Firefox specifically:</b> there is no Event Listeners sidebar and
        <code>getEventListeners()</code> does not exist — that is Chrome-only. What Firefox does have is an
        <b>event</b> badge next to elements in the Inspector's HTML pane; click it for a popup listing that element's
        listeners with file and line, and an arrow that jumps to the code in the Debugger. That is per-element
        though, so for a whole-page count use the snippet above.</p>
      </details>
    </div>`;
  }

  /* ======================================================================================== */
  /* CANVAS                                                                                   */
  /* ======================================================================================== */

  _tabCanvas() {
    const c = this.cache.canvas;
    const p = P();
    if (!c.available) return `<p class="dmm-empty">Canvas is not active. Open a scene and refresh.</p>`;

    return `
    <div class="dmm-grid-3">
      <div class="dmm-card mini"><label>Display objects</label><b>${num(c.totalObjects)}</b><small>max depth ${c.maxDepth}${c.truncated ? " · walk truncated" : ""}</small></div>
      <div class="dmm-card mini"><label>Texture memory</label><b>${bytes(c.textures.bytes)}</b><small>${num(c.textures.count)} base textures</small></div>
      <div class="dmm-card mini"><label>Filters</label><b>${num(c.filterCount)}</b><small>on ${num(c.filteredObjects)} objects</small></div>
      <div class="dmm-card mini"><label>Ticker listeners</label><b>${num(c.tickerListeners)}</b><small>run every frame</small></div>
      <div class="dmm-card mini"><label>Renderer</label><b>${esc(c.renderer?.type || "?")}</b><small>PIXI ${esc(c.pixi)}${c.renderer?.contextLost ? " · CONTEXT LOST" : ""}</small></div>
      <div class="dmm-card mini"><label>Resolution</label><b>${c.renderer ? `${c.renderer.width}×${c.renderer.height}` : "—"}</b><small>@${c.renderer?.resolution ?? "?"}x</small></div>
    </div>

    ${c.scene ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-map"></i> Current scene — ${esc(c.scene.name)}</h3>
      <div class="dmm-kv">
        <div><label>Dimensions</label><b>${esc(c.scene.dims)}</b></div>
        <div><label>Grid</label><b>${esc(c.scene.grid)}</b></div>
        <div><label>Token vision</label><b>${c.scene.tokenVision ? "on" : "off"}</b></div>
        <div><label>Fog</label><b>${esc(c.scene.fogExploration ?? "—")}</b></div>
        <div><label>Source data</label><b>${bytes(c.scene.sourceBytes)}</b></div>
        ${c.scene.levels != null ? `<div><label>Levels</label><b>${c.scene.levels}</b></div>` : ""}
        ${Object.entries(c.scene.embedded).map(([k, v]) => `<div><label>${esc(k)}</label><b>${num(v)}</b></div>`).join("")}
      </div>
      <p class="dmm-help">Walls dominate vision-polygon cost; lights dominate lighting-pass cost. If a scene has
      thousands of walls and token vision on, that is a scene-design cost, not a module cost — and no amount of
      module muting will fix it.</p>
    </div>` : ""}

    <div class="dmm-card">
      <h3><i class="fa-solid fa-filter"></i> Active filters</h3>
      <p class="dmm-help">Each filtered object forces PIXI to render into a separate texture and then composite it.
      Filters applied per-token rather than per-layer are one of the most reliable ways to destroy frame rate.</p>
      ${table("filters", [
        { key: "name", label: "Filter" },
        { key: "count", label: "Instances", align: "right", render: (r) => num(r.count) },
        { key: "enabled", label: "Enabled", align: "right", render: (r) => num(r.enabled) },
        { key: "on", label: "Applied to" }
      ], c.filters, { empty: "No filters active." })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-image"></i> Largest textures</h3>
      ${table("tex", [
        { key: "key", label: "Texture" },
        { key: "w", label: "Size", render: (r) => `${r.w}×${r.h}` },
        { key: "bytes", label: "VRAM", align: "right", render: (r) => bytes(r.bytes) },
        { key: "share", label: "", render: (r) => bar(r.bytes, c.textures.biggest[0]?.bytes || 1, "") }
      ], c.textures.biggest)}
      <p class="dmm-help">VRAM is width×height×4 bytes regardless of how well the file compresses on disk. A 8000×6000
      webp that is 3 MB on disk is 192 MB in video memory.</p>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-layer-group"></i> Layers</h3>
      ${table("layers", [
        { key: "name", label: "Layer" },
        { key: "objects", label: "Objects", align: "right", render: (r) => num(r.objects) },
        { key: "placeables", label: "Placeables", align: "right", render: (r) => (r.placeables == null ? "—" : num(r.placeables)) },
        { key: "visible", label: "Visible", render: (r) => (r.visible ? "yes" : "no") }
      ], c.layers)}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-shapes"></i> Objects by class</h3>
      ${table("classes", [
        { key: "name", label: "Class" },
        { key: "n", label: "Count", align: "right", render: (r) => num(r.n) },
        { key: "share", label: "", render: (r) => bar(r.n, c.byClass[0]?.n || 1, "") }
      ], c.byClass)}
      ${c.byOwner.length ? `<h4>Attributed to packages</h4>${table("canvasOwner", [
        { key: "owner", label: "Package" },
        { key: "n", label: "Objects", align: "right", render: (r) => num(r.n) }
      ], c.byOwner)}`
      : `<p class="dmm-help">Canvas objects are not attributed to packages. Enable <b>deep canvas probe</b> in the
         probe configuration and reload — it tags every display object with its creator, at the cost of a small
         overhead on <code>addChild</code>.</p>`}
    </div>`;
  }

  /* ======================================================================================== */
  /* DATA                                                                                     */
  /* ======================================================================================== */

  _tabData() {
    const d = this.cache.data;
    if (!d) {
      return `<div class="dmm-card">
        <h3><i class="fa-solid fa-database"></i> World data scan</h3>
        <p class="dmm-help">Walks every document in the world — including embedded tokens, items and effects — and
        measures how many bytes of flag data each module has written into your world. Flag bloat is the usual
        explanation for slow world loads, slow scene switches and oversized update packets.</p>
        <p class="dmm-help">This scan is chunked and yields between batches, so it will not freeze the client, but on
        a large world it can take a while.</p>
        <button type="button" class="dmm-primary" data-action="scanData">Run world data scan</button>
      </div>`;
    }
    return `
    <div class="dmm-grid-3">
      <div class="dmm-card mini"><label>Documents scanned</label><b>${num(d.totals.docs)}</b><small>+${num(d.totals.embedded)} embedded</small></div>
      <div class="dmm-card mini"><label>Total source data</label><b>${bytes(d.totals.docBytes)}</b></div>
      <div class="dmm-card mini"><label>Module flag data</label><b>${bytes(d.totals.flagBytes)}</b><small>${pct((d.totals.flagBytes / Math.max(1, d.totals.docBytes)) * 100)} of world</small></div>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-tags"></i> Flag data by module</h3>
      ${table("flags", [
        { key: "namespace", label: "Namespace", render: (r) => `<code>${esc(r.namespace)}</code>${r.installed ? "" : ` <em class="dmm-crit">not installed</em>`}` },
        { key: "bytes", label: "Bytes", align: "right", render: (r) => bytes(r.bytes) },
        { key: "docs", label: "Documents", align: "right", render: (r) => num(r.docs) },
        { key: "byType", label: "Distribution" },
        { key: "biggest", label: "Biggest single document", render: (r) => (r.biggest ? `${esc(r.biggest.name)} <small>${esc(r.biggest.type)} · ${bytes(r.biggest.bytes)}</small>` : "—") },
        { key: "share", label: "", render: (r) => bar(r.bytes, d.flags[0]?.bytes || 1, "") }
      ], d.flags)}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-folder-tree"></i> Documents by type</h3>
      ${table("docs", [
        { key: "type", label: "Type" },
        { key: "count", label: "Count", align: "right", render: (r) => num(r.count) },
        { key: "bytes", label: "Source bytes", align: "right", render: (r) => bytes(r.bytes) },
        { key: "avg", label: "Average", align: "right", render: (r) => bytes(r.count ? r.bytes / r.count : 0) }
      ], d.documents.map((x) => ({ ...x, avg: x.count ? x.bytes / x.count : 0 })))}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-sliders"></i> Settings storage</h3>
      ${table("settings", [
        { key: "namespace", label: "Namespace", render: (r) => `<code>${esc(r.namespace)}</code>` },
        { key: "keys", label: "Keys", align: "right" },
        { key: "worldBytes", label: "World", align: "right", render: (r) => bytes(r.worldBytes) },
        { key: "clientBytes", label: "Client", align: "right", render: (r) => bytes(r.clientBytes) },
        { key: "biggest", label: "Largest key", render: (r) => (r.biggest ? `<small>${esc(r.biggest.key)} · ${bytes(r.biggest.bytes)}</small>` : "—") }
      ], d.settings)}
      <p class="dmm-help">localStorage total: <b>${bytes(d.localStorage.totalBytes)}</b> — browsers cap this around
      5–10 MB per origin, and hitting the cap makes every client-setting write throw.</p>
      ${table("ls", [
        { key: "namespace", label: "localStorage namespace" },
        { key: "bytes", label: "Bytes", align: "right", render: (r) => bytes(r.bytes) },
        { key: "share", label: "", render: (r) => bar(r.bytes, d.localStorage.byNamespace[0]?.bytes || 1, "") }
      ], d.localStorage.byNamespace.slice(0, 20))}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-book"></i> Compendium packs <small>${d.packs.length} total</small></h3>
      ${table("packs", [
        { key: "id", label: "Pack" },
        { key: "owner", label: "Package" },
        { key: "type", label: "Type" },
        { key: "indexed", label: "Entries", align: "right", render: (r) => num(r.indexed) },
        { key: "loaded", label: "Fully loaded", render: (r) => (r.loaded ? `<b class="dmm-warn">yes</b>` : "no") }
      ], d.packs.slice(0, 60))}
      <p class="dmm-help">Packs are indexed at startup and loaded lazily. A pack marked <em>fully loaded</em> has had
      all its documents pulled into memory by something — usually a search or browser module indexing everything.
      That is a real, permanent memory cost.</p>
    </div>`;
  }

  /* ======================================================================================== */
  /* NETWORK                                                                                  */
  /* ======================================================================================== */

  _tabNetwork() {
    const p = P();
    const elapsedMin = (performance.now() - p.p0) / 60000;
    const net = [...p.net.values()].filter((n) => n.requests).sort((a, b) => b.requests - a.requests);
    const emits = [...p.socket.emits.values()].sort((a, b) => b.count - a.count).slice(0, 40);
    const recv = [...p.socket.receives.values()].sort((a, b) => b.count - a.count).slice(0, 40);
    const res = this.cache.resources || [];

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-arrow-right-arrow-left"></i> Runtime HTTP requests</h3>
      <p class="dmm-help">Requests made after load — file browsing, image fetching, polling. Steady per-minute
      traffic from a module is background work you are paying for continuously.</p>
      ${table("net", [
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "requests", label: "Requests", align: "right", render: (r) => num(r.requests) },
        { key: "perMin", label: "Per minute", align: "right", render: (r) => (r.requests / Math.max(0.01, elapsedMin)).toFixed(1) },
        { key: "bytes", label: "Bytes", align: "right", render: (r) => bytes(r.bytes) },
        { key: "total", label: "Total time", align: "right", render: (r) => ms(r.total) },
        { key: "max", label: "Slowest", align: "right", render: (r) => ms(r.max) },
        { key: "errors", label: "Failed", align: "right", render: (r) => (r.errors ? `<b class="dmm-crit">${r.errors}</b>` : "—") },
        { key: "paths", label: "Top paths", render: (r) => `<small>${esc([...r.byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(", "))}</small>` }
      ], net.map((n) => ({ ...n, perMin: n.requests / Math.max(0.01, elapsedMin) })), { empty: "No runtime requests recorded." })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-tower-broadcast"></i> Socket traffic</h3>
      <p class="dmm-help">Everything here fans out to every connected player. High-rate socket traffic makes
      <em>other people's</em> clients stutter, which is invisible if you only watch your own FPS.</p>
      <div class="dmm-grid-2">
        <div>
          <h4>Outgoing (${bytes(p.socket.bytesOut)})</h4>
          ${table("emits", [
            { key: "event", label: "Event" },
            { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
            { key: "count", label: "Count", align: "right", render: (r) => num(r.count) },
            { key: "perMin", label: "/min", align: "right", render: (r) => (r.count / Math.max(0.01, elapsedMin)).toFixed(1) },
            { key: "bytes", label: "Bytes", align: "right", render: (r) => bytes(r.bytes) }
          ], emits.map((e) => ({ ...e, perMin: e.count / Math.max(0.01, elapsedMin) })), { empty: "No outgoing traffic recorded." })}
        </div>
        <div>
          <h4>Incoming (${bytes(p.socket.bytesIn)})</h4>
          ${table("recv", [
            { key: "event", label: "Event" },
            { key: "count", label: "Count", align: "right", render: (r) => num(r.count) },
            { key: "bytes", label: "Bytes", align: "right", render: (r) => bytes(r.bytes) }
          ], recv, { empty: "No incoming traffic recorded." })}
        </div>
      </div>
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-download"></i> Load-time payload by package</h3>
      <p class="dmm-help">What each package made the browser download and parse at world load. This is a startup-time
      and baseline-memory cost, not a frame-rate cost — do not confuse the two.</p>
      ${table("assets", [
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "decoded", label: "Decoded", align: "right", render: (r) => bytes(r.decoded) },
        { key: "js", label: "JS", align: "right", render: (r) => bytes(r.js) },
        { key: "css", label: "CSS", align: "right", render: (r) => bytes(r.css) },
        { key: "img", label: "Media", align: "right", render: (r) => bytes(r.img) },
        { key: "count", label: "Files", align: "right", render: (r) => num(r.count) },
        { key: "duration", label: "Network time", align: "right", render: (r) => ms(r.duration) },
        { key: "biggest", label: "Largest file", render: (r) => (r.biggest ? `<small>${esc(r.biggest.name)} · ${bytes(r.biggest.bytes)}</small>` : "—") }
      ], res.slice(0, 60))}
    </div>`;
  }

  /* ======================================================================================== */
  /* TIMELINE                                                                                 */
  /* ======================================================================================== */

  _tabTimeline() {
    const p = P();
    const lt = p.longTasks.toArray().slice(-60).reverse();
    const spans = p.spans.toArray().slice(-120).reverse();
    const maxSpan = Math.max(1, ...spans.map((s) => s.dur));

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-hourglass-half"></i> Long tasks <small>main-thread blocks over 50 ms</small></h3>
      ${p.capabilities?.longTask === false ? `<p class="dmm-help dmm-cap-warning">
        <i class="fa-solid fa-circle-info"></i> <b>Long-task detection is not supported in this browser</b>
        (it is a Chromium-only entry type). This table will stay empty regardless of how bad things get — an empty
        list here is <em>not</em> evidence of smooth performance. Use the frame-time p99 on the Frames tab and the
        "Slowest recent callbacks" table below instead, both of which work everywhere.</p>` : ""}
      <p class="dmm-help">These are the freezes. Attribution is by overlapping instrumented spans — if a task shows
      no attribution, the blocking work happened outside any hook, timer, listener or ticker callback (core rendering,
      layout, GC, or a module doing work at the top level of a promise chain).</p>
      ${table("longtasks", [
        { key: "t", label: "When", render: (r) => new Date(r.t).toLocaleTimeString() },
        { key: "dur", label: "Blocked for", align: "right", render: (r) => `<b class="${r.dur > 250 ? "dmm-crit" : "dmm-warn"}">${ms(r.dur)}</b>` },
        { key: "attribution", label: "Attributed to", render: (r) => (r.attribution.length ? r.attribution.map((a) => `<code>${esc(a.owner)}</code> ${ms(a.ms)}`).join(" · ") : `<small>unattributed</small>`) }
      ], lt, { empty: "No long tasks recorded. That is a good sign." })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-list-timeline"></i> Slowest recent callbacks <small>over ${p.cfg.spanThresholdMs} ms</small></h3>
      ${table("spans", [
        { key: "t", label: "When", render: (r) => new Date(r.t).toLocaleTimeString() },
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "kind", label: "Kind" },
        { key: "label", label: "What" },
        { key: "dur", label: "Total", align: "right", render: (r) => ms(r.dur) },
        { key: "self", label: "Self", align: "right", render: (r) => ms(r.self) },
        { key: "share", label: "", render: (r) => bar(r.dur, maxSpan, "") }
      ], spans, { empty: "Nothing slow recorded yet." })}
    </div>`;
  }

  /* ======================================================================================== */
  /* ERRORS                                                                                   */
  /* ======================================================================================== */

  _tabErrors() {
    const p = P();
    const sigs = [...p.errorSignatures.entries()]
      .map(([sig, count]) => {
        const [owner, where, message] = sig.split("|");
        return { owner, where, message, count };
      })
      .sort((a, b) => b.count - a.count);
    const recent = p.errors.toArray().slice(-40).reverse();
    // Kept so the click handler can freeze exactly the row that was rendered, even if the
    // ring buffer has moved on by the time you click.
    this._lastErrorList = recent;
    this._lastErrorSigs = sigs;

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-bug"></i> Error signatures <small>deduplicated</small></h3>
      <p class="dmm-help">A hook that throws on every invocation is often more expensive than one doing real work —
      constructing a stack trace is not cheap, and the module's intended behaviour is broken on top of it.
      A high count here is a strong signal.</p>
      ${table("errsig", [
        { key: "owner", label: "Package", render: (r) => `<code>${esc(r.owner)}</code>` },
        { key: "count", label: "Occurrences", align: "right", render: (r) => `<b class="${r.count > 100 ? "dmm-crit" : r.count > 10 ? "dmm-warn" : ""}">${num(r.count)}</b>` },
        { key: "where", label: "Where" },
        { key: "message", label: "Message" }
      ], sigs, { empty: "No errors recorded." })}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-clock-rotate-left"></i> Recent errors with stacks</h3>
      <p class="dmm-help">Click an error to open its stack in a frozen window that will not refresh out from under you.</p>
      ${recent.length ? recent.map((e, i) => `
        <div class="dmm-finding clickable sev-2" data-action="openError" data-index="${i}" title="Open a frozen snapshot">
          <span class="dmm-finding-head">${sevIcon(2)} <code>${esc(e.owner)}</code> <b>${esc(e.message)}</b>
            <span class="dmm-metric">${new Date(e.t).toLocaleTimeString()} · ${esc(e.where)}</span>
            <i class="fa-solid fa-up-right-and-down-left-from-center dmm-open-hint"></i></span>
        </div>`).join("") : `<p class="dmm-empty">None.</p>`}
    </div>

    <div class="dmm-card">
      <h3><i class="fa-solid fa-scroll"></i> Probe log</h3>
      ${table("plog", [
        { key: "t", label: "When", render: (r) => new Date(r.t).toLocaleTimeString() },
        { key: "kind", label: "Kind" },
        { key: "text", label: "Message" }
      ], p.events.toArray().slice(-40).reverse())}
    </div>`;
  }

  /* ======================================================================================== */
  /* SNAPSHOTS                                                                                */
  /* ======================================================================================== */

  _tabSnapshots() {
    const snaps = this.snapshots;
    const diff = snaps.length >= 2 ? diffSnapshots(snaps[0], snaps[snaps.length - 1]) : null;

    return `
    <div class="dmm-card">
      <h3><i class="fa-solid fa-camera"></i> Snapshots <small>${snaps.length} taken</small></h3>
      <p class="dmm-help">The intended workflow for long-session problems: take a snapshot at the start of the
      session, another two or three hours in, and read the diff. A leak is a counter that only goes one way; the diff
      tells you which one and who owns it, which is exactly what you cannot see from a single point in time.</p>
      <button type="button" class="dmm-primary" data-action="snapshot">Take snapshot now</button>
      ${snaps.length ? `<button type="button" class="dmm-mini" data-action="clearSnapshots">Clear</button>` : ""}
      ${table("snaps", [
        { key: "label", label: "Label" },
        { key: "elapsedMin", label: "Session time", align: "right", render: (r) => `${r.elapsedMin.toFixed(0)} min` },
        { key: "heap", label: "Heap", align: "right", render: (r) => bytes(r.heap) },
        { key: "fps", label: "FPS", align: "right", render: (r) => r.fps.toFixed(0) },
        { key: "domNodes", label: "DOM", align: "right", render: (r) => num(r.domNodes) },
        { key: "listeners", label: "Listeners", align: "right", render: (r) => num(r.listeners) },
        { key: "canvasObjects", label: "Canvas", align: "right", render: (r) => num(r.canvasObjects) },
        { key: "chatDom", label: "Chat DOM", align: "right", render: (r) => num(r.chatDom) }
      ], snaps, { empty: "None yet." })}
    </div>

    ${diff ? `<div class="dmm-card">
      <h3><i class="fa-solid fa-code-compare"></i> First → last <small>${diff.minutes.toFixed(0)} minutes apart</small></h3>
      ${table("diffglobal", [
        { key: "name", label: "Counter" },
        { key: "from", label: "Before", align: "right", render: (r) => (r.fmt ? r.fmt(r.from) : num(r.from)) },
        { key: "to", label: "After", align: "right", render: (r) => (r.fmt ? r.fmt(r.to) : num(r.to)) },
        { key: "delta", label: "Change", align: "right", render: (r) => `<b class="${r.bad ? "dmm-crit" : ""}">${r.delta >= 0 ? "+" : ""}${r.fmt ? r.fmt(r.delta) : num(r.delta)}</b>` }
      ], [
        { name: "Heap", ...diff.heap, fmt: bytes, bad: diff.heapPerHour > 1.5e8 },
        { name: "FPS", ...diff.fps, fmt: (v) => (v ?? 0).toFixed(0), bad: diff.fps.delta < -10 },
        { name: "DOM elements", ...diff.domNodes, bad: diff.domNodes.delta > 8000 },
        { name: "Live listeners", ...diff.listeners, bad: diff.listeners.delta > 400 },
        { name: "Live intervals", ...diff.intervals, bad: diff.intervals.delta > 4 },
        { name: "Canvas objects", ...diff.canvasObjects, bad: diff.canvasObjects.delta > 5000 },
        { name: "Texture memory", ...diff.textureBytes, fmt: bytes, bad: diff.textureBytes.delta > 5e8 },
        { name: "Chat messages in DOM", ...diff.chatDom, bad: diff.chatDom.delta > 400 },
        { name: "Open applications", ...diff.apps, bad: diff.apps.delta > 6 }
      ])}
      <div class="dmm-legend">Heap trend across this window: <b>${bytes(diff.heapPerHour)}/hour</b></div>
      <h4>Per-package change over the window</h4>
      ${table("diffowners", [
        { key: "id", label: "Package", render: (r) => `<code>${esc(r.id)}</code>` },
        { key: "cpuMs", label: "CPU", align: "right", render: (r) => ms(r.cpuMs) },
        { key: "hookCalls", label: "Hook calls", align: "right", render: (r) => num(r.hookCalls) },
        { key: "domOps", label: "DOM ops", align: "right", render: (r) => num(r.domOps) },
        { key: "listenerRegs", label: "Listeners added", align: "right", render: (r) => num(r.listenerRegs) },
        { key: "liveIntervals", label: "Δ live intervals", align: "right", render: (r) => (r.liveIntervals ? `<b class="dmm-crit">+${r.liveIntervals}</b>` : "—") },
        { key: "errors", label: "Errors", align: "right", render: (r) => num(r.errors) },
        { key: "retainedBytes", label: "Δ retained", align: "right", render: (r) => (r.retainedBytes ? bytes(r.retainedBytes) : "—") }
      ], diff.owners.slice(0, 40))}
    </div>` : `<p class="dmm-help">Take at least two snapshots to see a diff.</p>`}`;
  }

  /* ======================================================================================== */
  /* ACTIONS                                                                                  */
  /* ======================================================================================== */

  async _actTab(event, target) {
    this.tab = target.dataset.tab;
    await this.render();
  }

  /* -- frozen snapshots ------------------------------------------------------------------- */

  /**
   * Deep-copy everything relevant to one finding, right now. Nothing here may hold a live
   * reference into probe state: the whole point is that these numbers stop moving.
   */
  _freezeEvidence(ownerId, source) {
    const p = P();
    const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
    const samples = p.samples.toArray();
    const ev = {
      row: null, hooks: [], listeners: [], intervals: [], spans: [], longTasks: [], errors: [], libWrapper: [],
      canvas: null, dom: null, data: null, topListeners: [], inputs: [], socket: [],
      heapSeries: [], heapTrend: null, growth: [], retained: []
    };

    const row = this.cache.rows.find((r) => r.id === ownerId);
    if (row) ev.row = clone(row);

    if (ownerId) {
      ev.hooks = [...p.hooks.values()].filter((h) => h.owner === ownerId && (h.calls || h.live))
        .sort((a, b) => b.total - a.total).slice(0, 20)
        .map((h) => ({ hook: h.hook, calls: h.calls, total: h.total, self: h.self, max: h.max, live: h.live, errors: h.errors }));

      ev.listeners = [...p.listeners.values()].filter((l) => l.owner === ownerId)
        .sort((a, b) => b.attached - a.attached || b.live - a.live).slice(0, 20)
        .map((l) => ({
          type: l.type, attached: l.attached, live: l.live, regs: l.regs, calls: l.calls,
          total: l.total, max: l.max,
          targets: [...l.targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t}×${n}`).join(", ")
        }));

      ev.libWrapper = [];
      for (const [target, list] of p.libWrapper) {
        for (const w of list) {
          if (w.owner !== ownerId) continue;
          ev.libWrapper.push({
            target, type: w.type, calls: w.calls, self: w.self, inclusive: w.inclusive,
            ratio: w.inclusive > 0 ? (w.self / w.inclusive) * 100 : 0
          });
        }
      }
      ev.libWrapper.sort((a, b) => b.inclusive - a.inclusive);

      ev.intervals = [...p.liveIntervals.values()].filter((i) => i.owner === ownerId)
        .map((i) => ({ delay: i.delay, fires: i.fires, totalMs: i.totalMs, created: i.created }))
        .sort((a, b) => a.delay - b.delay);

      ev.spans = p.spans.toArray().filter((s) => s && s.owner === ownerId)
        .sort((a, b) => b.dur - a.dur).slice(0, 15)
        .map((s) => ({ t: s.t, kind: s.kind, label: s.label, dur: s.dur, self: s.self }));

      ev.longTasks = p.longTasks.toArray().filter((lt) => lt.attribution.some((a) => a.owner === ownerId))
        .slice(-15).reverse()
        .map((lt) => ({
          t: lt.t, dur: lt.dur,
          mine: lt.attribution.find((a) => a.owner === ownerId)?.ms || 0,
          others: lt.attribution.filter((a) => a.owner !== ownerId).map((a) => `${a.owner} ${a.ms.toFixed(0)}ms`).join(", ") || "—"
        }));

      const seen = new Set();
      for (const e of p.errors.toArray().slice().reverse()) {
        if (e.owner !== ownerId) continue;
        const sig = `${e.where}|${e.message}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const full = [...p.errorSignatures.entries()].find(([k]) => k.startsWith(`${ownerId}|${e.where}|`));
        ev.errors.push({ message: e.message, where: e.where, stack: e.stack, count: full ? full[1] : 1 });
        if (ev.errors.length >= 5) break;
      }
    }

    switch (source) {
      case "canvas": ev.canvas = clone(this.cache.canvas); break;
      case "dom":
      case "growth":
        ev.dom = clone(this.cache.dom);
        ev.topListeners = [...p.listeners.values()].sort((a, b) => b.live - a.live).slice(0, 12)
          .map((l) => ({ owner: l.owner, type: l.type, live: l.live }));
        break;
      case "data": ev.data = clone(this.cache.data); break;
      case "input": {
        // Do the cross-referencing the finding used to ask you to do by hand: for each slow
        // interaction, find the instrumented callbacks whose execution overlapped it.
        const spans = p.spans.toArray();
        const tasks = p.longTasks.toArray();
        ev.inputs = (p.inputLatency?.toArray() || []).slice(-25).reverse().map((i) => {
          const acc = new Map();
          if (isFinite(i.start)) {
            for (const s of spans) {
              if (!s) continue;
              const sEnd = s.p + s.dur;
              if (sEnd < i.start || s.p > i.end) continue;
              const overlap = Math.min(i.end, sEnd) - Math.max(i.start, s.p);
              if (overlap > 0) acc.set(s.owner, (acc.get(s.owner) || 0) + Math.min(overlap, s.self));
            }
          }
          const blocking = tasks.filter((lt) => isFinite(i.start) && lt.start < i.end && (lt.start + lt.dur) > i.start);
          return {
            t: i.t, name: i.name, dur: i.dur, delay: i.delay, processing: i.processing,
            present: i.present, discrete: i.discrete,
            during: [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
              .map(([o, msv]) => `${o} ${msv.toFixed(1)}ms`).join(", ") || "—",
            longTask: blocking.length ? `${blocking.length} × up to ${Math.max(...blocking.map((b) => b.dur)).toFixed(0)}ms` : "—"
          };
        });
        break;
      }
      case "socket":
        ev.socket = [...p.socket.emits.values()].sort((a, b) => b.count - a.count).slice(0, 20)
          .map((s) => ({ event: s.event, owner: s.owner, count: s.count, bytes: s.bytes }));
        break;
      case "memory":
        ev.heapSeries = samples.map((s) => s.heap).filter(Boolean);
        ev.heapTrend = clone(heapTrend(samples));
        ev.growth = [
          ["Live DOM event listeners", "listeners"], ["DOM elements", "domNodes"],
          ["Chat messages in DOM", "chatDom"], ["Live setInterval handles", "intervals"],
          ["Open application instances", "apps"]
        ].map(([name, field]) => {
          const d = drift(samples, field);
          return d ? { name, ...d } : null;
        }).filter(Boolean);
        ev.retained = (this.cache.memory?.modules || []).slice(0, 15).map((m) => ({ id: m.id, bytes: m.bytes }));
        break;
      default: break;
    }
    return ev;
  }

  _freezeVitals() {
    const p = P();
    const s = p.samples.toArray();
    const last = s[s.length - 1] || {};
    return {
      fps: last.fps || 0, heap: last.heap || 0, domNodes: last.domNodes || 0,
      listeners: last.listeners || 0, intervals: p.liveIntervals.size,
      apps: last.apps || 0, chatDom: last.chatDom || 0,
      droppedFrames: p.global.droppedFrames
    };
  }

  async _actOpenFinding(event, target) {
    const f = this.cache.findings[Number(target.dataset.index)];
    if (!f) return;
    const p = P();
    const payload = {
      kind: "finding",
      capturedAt: Date.now(),
      sessionMinutes: (performance.now() - p.p0) / 60000,
      finding: JSON.parse(JSON.stringify(f)),
      vitals: this._freezeVitals(),
      evidence: this._freezeEvidence(f.owner, f.source)
    };
    new FindingDetail({ id: `dmm-detail-${++_detailSeq}`, payload }).render({ force: true });
  }

  async _actOpenError(event, target) {
    const e = this._lastErrorList?.[Number(target.dataset.index)];
    if (!e) return;
    const p = P();
    const sigEntry = [...p.errorSignatures.entries()]
      .find(([k]) => k.startsWith(`${e.owner}|${e.where}|`));
    const payload = {
      kind: "error",
      capturedAt: Date.now(),
      sessionMinutes: (performance.now() - p.p0) / 60000,
      error: {
        owner: e.owner, where: e.where, message: e.message, stack: e.stack, t: e.t,
        signatureCount: sigEntry ? sigEntry[1] : e.count || 1
      },
      vitals: this._freezeVitals(),
      evidence: this._freezeEvidence(e.owner, "module")
    };
    new FindingDetail({ id: `dmm-detail-${++_detailSeq}`, payload }).render({ force: true });
  }

  async _actSort(event, target) {
    const t = target.dataset.table, k = target.dataset.key;
    const cur = this.sorts[t];
    this.sorts[t] = cur && cur.key === k ? { key: k, dir: -cur.dir } : { key: k, dir: -1 };
    await this.render();
  }

  async _actRefresh() {
    this.cache.resources = resourceCensus();
    this._invalidate();
    await this.render();
  }

  async _actToggleLive() {
    this.live = !this.live;
    if (this.live) this._startLive(); else this._stopLive();
    await this.render();
  }

  async _actReset() {
    P().resetCounters();
    this.cache.idle = null;
    ui.notifications?.info("Performance counters reset. Measurement window starts now.");
    await this.render();
  }

  async _actMute(event, target) {
    const p = P();
    const id = target.dataset.id;
    if (p.muted.has(id)) {
      p.unmute(id);
      ui.notifications?.info(`Unmuted ${id}.`);
    } else {
      p.mute(id);
      ui.notifications?.warn(`${id} is MUTED — its callbacks are no-ops. Auto-unmute in 3 minutes.`, { permanent: false });
      (p._raw.setTimeout)(() => {
        if (p.muted.has(id)) {
          p.unmute(id);
          ui.notifications?.info(`Auto-unmuted ${id}.`);
          if (this.rendered) this.render();
        }
      }, 180000);
    }
    await this.render();
  }

  async _actUnmuteAll() {
    P().unmuteAll();
    await this.render();
  }

  async _actGC() {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      ui.notifications?.info("Garbage collection requested.");
    } else {
      ui.notifications?.warn("Manual GC is unavailable. Launch with --js-flags=\"--expose-gc\" to enable it, or use the DevTools Memory tab.");
    }
    await this.render();
  }

  async _actIdle() {
    if (this.busy) return;
    this.busy = "Idle test running — do not touch anything";
    this.live = false;
    await this.render();
    try {
      this.cache.idle = await idleChurnTest(6000, (p) => { this.busy = `Idle test ${p}% — do not touch anything`; });
    } finally {
      this.busy = null;
      this.live = true;
      this._startLive();
      await this.render();
    }
  }

  async _actScanData() {
    if (this.busy) return;
    this.busy = "Scanning world data…";
    await this.render();
    try {
      this.cache.data = await dataCensus((msg) => { this.busy = `Scanning: ${msg}`; });
    } catch (err) {
      console.error(`${MODULE_ID} | data scan failed`, err);
      ui.notifications?.error("World data scan failed — see console.");
    } finally {
      this.busy = null;
      await this.render();
    }
  }

  async _actScanMemory() {
    if (this.busy) return;
    this.busy = "Estimating retained memory…";
    await this.render();
    await new Promise((r) => setTimeout(r, 30));
    try {
      this.cache.memory = memoryCensus();
    } catch (err) {
      console.error(`${MODULE_ID} | memory scan failed`, err);
    } finally {
      this.busy = null;
      await this.render();
    }
  }

  async _actSnapshot() {
    const p = P();
    this.snapshots.push(takeSnapshot(null, {
      samples: p.samples.toArray(),
      canvas: this.cache.canvas,
      rows: this.cache.rows
    }));
    ui.notifications?.info(`Snapshot ${this.snapshots.length} taken.`);
    this.tab = "snapshots";
    await this.render();
  }

  async _actListenerBaseline() {
    const b = P().markListenerBaseline();
    ui.notifications?.info(`Listener baseline marked at ${b.totalAttached} attached. Now open and close the window you suspect.`);
    await this.render();
  }

  async _actClearListenerBaseline() {
    P().clearListenerBaseline();
    await this.render();
  }

  async _actCopyRetention() {
    const d = P().listenerDelta();
    if (!d) return;
    const lines = [
      `Listener retention test — ${(d.sinceMs / 1000).toFixed(0)}s since baseline`,
      `Net change in attached listeners: ${d.totalAttachedDelta >= 0 ? "+" : ""}${d.totalAttachedDelta}`,
      "",
      ...d.rows.slice(0, 30).map((r) =>
        `${r.owner} ${r.type}: +${r.regsDelta} added, ${r.attachedDelta >= 0 ? "+" : ""}${r.attachedDelta} still attached ` +
        `(${(r.retainedRatio * 100).toFixed(0)}% retained) on ${(r.attachedBy || []).map(([l, n2]) => `${l}×${n2}`).join(", ") || "—"}`)
    ];
    const leaks = d.rows.filter((r) => r.retainedRatio > 0.7 && r.attachedDelta > 20);
    if (leaks.length) {
      lines.push("", "Registration sites for retained listeners:");
      for (const r of leaks.slice(0, 4)) {
        lines.push(`--- ${r.owner} ${r.type} ---`);
        for (const [l, st] of r.stacks || []) lines.push(`${l}\n${st}`);
      }
    }
    const text = lines.join("\n");
    console.log(text);
    await copyText(text, "Retention result");
  }

  async _actCopyIndependent() {
    console.log(INDEPENDENT_CHECK);
    await copyText(INDEPENDENT_CHECK, "Independent check snippet");
  }

  async _actClearSnapshots() {
    this.snapshots = [];
    await this.render();
  }

  async _actCopyFindings() {
    const p = P();
    const header = [
      `DMM Performance Checker — ${new Date().toISOString()}`,
      `Foundry ${game.version} · ${game.system?.id}@${game.system?.version} · ${p.capabilities?.engine || "?"} · ${p.refreshHz} Hz`,
      `${((performance.now() - p.p0) / 60000).toFixed(1)} min measured · ${game.modules.filter((m) => m.active).length} active modules`,
      ""
    ].join("\n");
    const text = header + this.cache.findings.map((f) =>
      `[${f.sevName.toUpperCase()}] ${f.owner ? `${f.owner}: ` : ""}${f.title} (${f.metric})\n  ${f.detail}\n  → ${f.action}`
    ).join("\n\n");
    console.log(text);
    await copyText(text || "No findings.", "Findings");
  }

  async _actExport() {
    const p = P();
    const payload = {
      module: MODULE_ID,
      version: p.version,
      exportedAt: new Date().toISOString(),
      foundry: { version: game.version, system: `${game.system?.id}@${game.system?.version}` },
      probe: {
        early: p.early, preExisting: p.preExisting, config: p.cfg,
        overhead: p.overhead, elapsedMs: performance.now() - p.p0,
        pixi: globalThis.PIXI?.VERSION
      },
      activeModules: game.modules.filter((m) => m.active).map((m) => ({ id: m.id, title: m.title, version: m.version })),
      scorecard: this.cache.rows,
      findings: this.cache.findings,
      hooks: [...p.hooks.values()],
      hookEnvelope: [...p.hookEnvelope.values()],
      observers: [...(p.observers?.values?.() || [])],
      ticker: [...p.ticker.values()].map((t) => ({ ...t, fns: [...t.fns.entries()] })),
      listeners: [...p.listeners.values()].map((l) => ({ ...l, targets: [...l.targets.entries()] })),
      net: [...p.net.values()].map((n) => ({ ...n, byPath: [...n.byPath.entries()] })),
      db: [...p.db.values()].map((d) => ({ ...d, byType: [...d.byType.entries()] })),
      libWrapper: [...p.libWrapper.entries()],
      refreshHz: p.refreshHz,
      capabilities: p.capabilities,
      socket: {
        emits: [...p.socket.emits.values()], receives: [...p.socket.receives.values()],
        bytesIn: p.socket.bytesIn, bytesOut: p.socket.bytesOut
      },
      liveIntervals: [...p.liveIntervals.values()],
      samples: p.samples.toArray(),
      longTasks: p.longTasks.toArray(),
      spans: p.spans.toArray(),
      inputLatency: p.inputLatency?.toArray() || [],
      errors: p.errors.toArray(),
      errorSignatures: [...p.errorSignatures.entries()],
      probeLog: p.events.toArray(),
      census: {
        dom: this.cache.dom, canvas: this.cache.canvas,
        data: this.cache.data, memory: this.cache.memory, resources: this.cache.resources
      },
      snapshots: this.snapshots,
      idleTest: this.cache.idle
    };
    const name = `dmm-perf-${game.world.id}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    const json = JSON.stringify(payload, (k, v) => (v instanceof Map ? [...v.entries()] : v), 2);
    saveFile(json, "application/json", name);
    ui.notifications?.info(`Exported ${name}`);
  }

  async _actConfig() {
    const p = P();
    const c = p.cfg;
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${label}</option>`;
    const content = `
      <div class="dmm-config">
        <p>Changes are stored locally and take effect on <b>reload</b>, because instrumentation must be installed before other modules load.</p>
        <label>Instrumentation mode
          <select name="mode">
            ${opt("full", "Full — per-callback timing and attribution", c.mode)}
            ${opt("envelope", "Envelope — hook fire rates only, no callback wrapping", c.mode)}
            ${opt("off", "Off — no instrumentation at all", c.mode)}
          </select></label>
        <p class="notes">Use <b>envelope</b> if you suspect the probe's callback wrapping is interfering with a module
        that inspects <code>Hooks.events</code> by function identity. You lose per-module attribution.</p>
        <label><input type="checkbox" name="domProbe" ${c.domProbe ? "checked" : ""}> DOM mutation + storage probe</label>
        <label><input type="checkbox" name="listenerProbe" ${c.listenerProbe ? "checked" : ""}> Event listener probe</label>
        <label><input type="checkbox" name="tickerProbe" ${c.tickerProbe ? "checked" : ""}> PIXI ticker probe (per-frame cost)</label>
        <label><input type="checkbox" name="netProbe" ${c.netProbe ? "checked" : ""}> Network probe</label>
        <label><input type="checkbox" name="dbProbe" ${c.dbProbe ? "checked" : ""}> Database write probe</label>
        <label><input type="checkbox" name="canvasProbe" ${c.canvasProbe ? "checked" : ""}> <b>Deep canvas probe</b> — tag every display object with its creator</label>
        <p class="notes">The deep canvas probe patches <code>PIXI.Container#addChild</code>, which is very hot during
        scene draw. It is the only way to attribute canvas objects to modules, but expect a measurable cost on scene
        load. Turn it on for one diagnostic session, not permanently.</p>
        <label>Overhead budget (%) <input type="number" name="overheadBudgetPct" value="${c.overheadBudgetPct}" step="0.5" min="0.5" max="25"></label>
        <label>Timeline span threshold (ms) <input type="number" name="spanThresholdMs" value="${c.spanThresholdMs}" step="0.5" min="0.5" max="50"></label>
        <label>Sample interval (ms) <input type="number" name="sampleIntervalMs" value="${c.sampleIntervalMs}" step="500" min="500" max="30000"></label>
      </div>`;

    const result = await DialogV2().prompt({
      window: { title: "Probe configuration", icon: "fa-solid fa-sliders" },
      position: { width: 560 },
      content,
      ok: { label: "Save", callback: (ev, button) => new (FormData_())(button.form).object },
      rejectClose: false
    }).catch(() => null);

    if (!result) return;
    P().setConfig({
      mode: result.mode,
      domProbe: !!result.domProbe,
      listenerProbe: !!result.listenerProbe,
      tickerProbe: !!result.tickerProbe,
      netProbe: !!result.netProbe,
      dbProbe: !!result.dbProbe,
      canvasProbe: !!result.canvasProbe,
      overheadBudgetPct: Number(result.overheadBudgetPct) || 1.5,
      spanThresholdMs: Number(result.spanThresholdMs) || 1.5,
      sampleIntervalMs: Number(result.sampleIntervalMs) || 2000
    });
    ui.notifications?.info("Probe configuration saved. Reload (F5) for it to take effect.");
  }
}
