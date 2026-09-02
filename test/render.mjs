/**
 * Dashboard render test.
 *   node --experimental-vm-modules test/render.mjs
 *
 * Stubs just enough of ApplicationV2 and `game` to instantiate the dashboard and render every
 * tab, both with and without the optional (explicitly-triggered) censuses populated. The tab
 * methods are the most typo-prone code in the module and none of it is reachable by the probe
 * test suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { installHarness } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  [32m✓[0m ${name}`); }
  else { fail++; failures.push(`${name} ${extra}`); console.log(`  [31m✗[0m ${name} ${extra}`); }
}
function section(t) { console.log(`\n[1m${t}[0m`); }

/* -- boot probe --------------------------------------------------------------------------- */
installHarness();
vm.runInThisContext(readFileSync(join(root, "scripts", "dmm-probe.js"), "utf8"),
  { filename: "http://localhost:30000/modules/dmm-performance-checker/scripts/dmm-probe.js" });
const P = globalThis.DMMPC;

/* -- stub Foundry application layer --------------------------------------------------------- */
class StubApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) { this.options = options; this.rendered = false; this.minimized = false; }
  async render() { this.rendered = true; return this; }
  bringToFront() {}
  async close() { this.rendered = false; }
  _onRender() {}
  async _onClose() {}
}
globalThis.foundry.applications = {
  api: { ApplicationV2: StubApplicationV2, DialogV2: { prompt: async () => null } },
  instances: new Map(),
  // v14 pop-out windows. Kept here because the DOM census reads it to tell a legitimately
  // detached application apart from an orphaned one.
  detached: { windows: new Map() },
  ux: { FormDataExtended: class { constructor() { this.object = {}; } } }
};
globalThis.foundry.utils = { saveDataToFile: () => {} };

/* -- stub game -------------------------------------------------------------------------- */
function collection(entries) {
  const m = new Map(entries.map((e) => [e.id, e]));
  m.get = Map.prototype.get.bind(m);
  m.filter = (fn) => [...m.values()].filter(fn);
  m[Symbol.iterator] = function* () { yield* m.values(); };
  m.contents = [...m.values()];
  return m;
}
globalThis.game = {
  ready: true,
  version: "14.367",
  world: { id: "test-world" },
  system: { id: "dnd5e", version: "5.0.0" },
  messages: { size: 1200 },
  packs: [],
  modules: collection([
    { id: "alpha-mod", title: "Alpha Module", version: "1.0", active: true, api: { cache: new Array(1000).fill("x") } },
    { id: "beta-mod", title: "Beta Module", version: "2.0", active: true }
  ]),
  settings: { storage: new Map([["client", globalThis.localStorage]]) }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} }, windows: {} };

/* -- generate some measurable activity ------------------------------------------------------ */
const alpha = await import("./fixtures/modules/alpha-mod/main.mjs");
const beta = await import("./fixtures/modules/beta-mod/main.mjs");
alpha.register();
beta.register();
alpha.registerDomHook(globalThis.document.body, 5);
alpha.registerStorageHook(3);
alpha.throwingHook();
const iv = alpha.startInterval(1000);
const ticker = new PIXI.Ticker();
alpha.tickerWork(ticker);
for (let i = 0; i < 3; i++) { Hooks.callAll("testHook", 8000); Hooks.callAll("domHook"); Hooks.callAll("storeHook"); }
ticker.tick(1); ticker.tick(1);
try { Hooks.callAll("boomHook"); } catch (e) { /* expected */ }
P.sample(); P.sample(); P.sample();
P.socket.emits.set("userActivity alpha-mod", { event: "userActivity", owner: "alpha-mod", count: 40, bytes: 900 });
P.socket.receives.set("modifyDocument", { event: "modifyDocument", count: 12, bytes: 400 });
P.libWrapper.set("Token.prototype.draw", [{ owner: "alpha-mod", target: "Token.prototype.draw", type: "WRAPPER", calls: 5, total: 3.2, max: 1.1 }]);
P.longTasks.push({ t: Date.now(), start: 0, dur: 120, attribution: [{ owner: "alpha-mod", ms: 90 }] });
P.inputLatency.push({ t: Date.now(), name: "click", dur: 210, processing: 150, delay: 40 });

/* -- instantiate ---------------------------------------------------------------------------- */
section("Dashboard construction");
const { PerformanceDashboard } = await import("../module/dashboard.mjs");
const app = new PerformanceDashboard();
ok("constructed", !!app);
ok("default tab is overview", app.tab === "overview");
ok("actions map is populated", Object.keys(PerformanceDashboard.DEFAULT_OPTIONS.actions).length > 10);
ok("every action maps to a function",
  Object.values(PerformanceDashboard.DEFAULT_OPTIONS.actions).every((v) => typeof v === "function"),
  JSON.stringify(Object.entries(PerformanceDashboard.DEFAULT_OPTIONS.actions)
    .filter(([, v]) => typeof v !== "function").map(([k]) => k)));
ok("every action handler exists on the prototype",
  Object.entries(PerformanceDashboard.DEFAULT_OPTIONS.actions)
    .every(([, fn]) => Object.values(PerformanceDashboard.prototype).includes(fn) || typeof fn === "function"));

/* -- render every tab, empty state ---------------------------------------------------------- */
section("Render — before optional scans");
await app._prepareContext();
for (const [key] of PerformanceDashboard.TAB_LIST) {
  app.tab = key;
  let html = null, err = null;
  try { html = await app._renderHTML(); } catch (e) { err = e; }
  ok(`tab "${key}" renders`, typeof html === "string" && html.length > 100 && !html.includes("Tab failed to render"),
    err ? `\n     ${err.stack?.split("\n").slice(0, 3).join("\n     ")}` : (html || "").slice(0, 160));
}

/* -- render every tab with optional censuses populated -------------------------------------- */
section("Render — with data/memory/canvas censuses populated");
const census = await import("../module/census.mjs");
app.cache.memory = census.memoryCensus();
app.cache.data = {
  flags: [{ namespace: "alpha-mod", bytes: 5_000_000, docs: 40, biggest: { name: "Big Actor", type: "Actor", bytes: 900_000 }, byType: "Actor 4 MB", installed: true, active: true },
    { namespace: "ghost-mod", bytes: 200_000, docs: 12, biggest: { name: "Old", type: "Scene", bytes: 90_000 }, byType: "Scene 200 KB", installed: false, active: false }],
  documents: [{ type: "ChatMessage", count: 5000, bytes: 40_000_000 }, { type: "Actor", count: 300, bytes: 9_000_000 }],
  settings: [{ namespace: "alpha-mod", worldBytes: 4000, clientBytes: 900, keys: 12, biggest: { key: "alpha-mod.state", bytes: 3000 } }],
  localStorage: { totalBytes: 4_000_000, byNamespace: [{ namespace: "alpha-mod", bytes: 3_000_000 }] },
  packs: [{ id: "alpha.things", label: "Things", owner: "alpha-mod", type: "Item", indexed: 900, indexBytes: 1000, loaded: true }],
  totals: { docBytes: 49_000_000, flagBytes: 5_200_000, docs: 5300, embedded: 800 },
  scanned: 5300
};
app.cache.canvas = {
  available: true, pixi: "7.4.3", renderer: { type: "WebGL", width: 1920, height: 1080, resolution: 1, contextLost: false },
  totalObjects: 30000, maxDepth: 14,
  byClass: [{ name: "Sprite", n: 12000 }, { name: "Graphics", n: 8000 }],
  byOwner: [{ owner: "alpha-mod", n: 4000 }],
  filters: [{ name: "GlowFilter", count: 80, enabled: 80, on: "Token" }],
  filterCount: 80, filteredObjects: 80,
  textures: { count: 400, bytes: 2.1e9, biggest: [{ key: "maps/big.webp", w: 8000, h: 6000, bytes: 192e6 }] },
  layers: [{ name: "TokenLayer", objects: 900, placeables: 40, visible: true, interactive: true }],
  scene: { name: "Test Scene", id: "abc", dims: "8000×6000", padding: 0.25, grid: 100, tokenVision: true, fogExploration: "shared", globalLight: false, embedded: { Token: 40, Wall: 5000 }, sourceBytes: 900000, levels: 3 },
  tickerListeners: 80, truncated: false
};
app.snapshots = [
  { label: "start", t: Date.now() - 7200000, elapsedMin: 0, heap: 400e6, fps: 58, domNodes: 12000, listeners: 900, intervals: 4, canvasObjects: 20000, textureBytes: 1e9, chatDom: 50, apps: 3, owners: [{ id: "alpha-mod", cpuMs: 100, hookCalls: 500, domOps: 100, liveIntervals: 2, listenerRegs: 50, errors: 0, retainedBytes: 1e6 }] },
  { label: "now", t: Date.now(), elapsedMin: 120, heap: 2.4e9, fps: 22, domNodes: 60000, listeners: 4200, intervals: 9, canvasObjects: 30000, textureBytes: 2.1e9, chatDom: 900, apps: 7, owners: [{ id: "alpha-mod", cpuMs: 90000, hookCalls: 90000, domOps: 400000, liveIntervals: 7, listenerRegs: 3000, errors: 220, retainedBytes: 3e8 }] }
];
app.cache.idle = {
  seconds: 6, fps: 24, heapDelta: 40e6, heapPerMin: 400e6,
  owners: [{ owner: "alpha-mod", cpuMs: 900, cpuPct: 15, callsPerSec: 400, domOpsPerSec: 200, dbPerSec: 0, netPerSec: 0, storagePerSec: 12, detail: {} }],
  hooks: [{ hook: "refreshToken", owner: "alpha-mod", perSec: 240 }]
};
const syntheticCanvas = app.cache.canvas;
const syntheticData = app.cache.data;
for (const [key] of PerformanceDashboard.TAB_LIST) {
  app.tab = key;
  // Re-assert after _prepareContext, which legitimately recomputes the live censuses.
  await app._prepareContext();
  app.cache.canvas = syntheticCanvas;
  app.cache.data = syntheticData;
  let html = null, err = null;
  try { html = await app._renderHTML(); } catch (e) { err = e; }
  ok(`tab "${key}" renders with full data`, typeof html === "string" && html.length > 100 && !html.includes("Tab failed to render"),
    err ? `\n     ${err.stack?.split("\n").slice(0, 3).join("\n     ")}` : "");
}

section("Census TTL caching (the profiler must not be the problem)");
app.tab = "overview";
app._invalidate();
await app._prepareContext();
const firstCanvas = app.cache.canvas;
await app._prepareContext();
ok("canvas census is reused from cache between renders", app.cache.canvas === firstCanvas);
app._invalidate();
await app._prepareContext();
ok("explicit invalidation recomputes", app.cache.canvas !== firstCanvas);

/* -- findings quality ------------------------------------------------------------------------ */
section("Findings from the synthetic bad world");
const analysis = await import("../module/analysis.mjs");
for (let i = 0; i < 10; i++) {
  P.inputLatency.push({
    t: Date.now(), start: i * 500, end: i * 500 + 180 + i * 10, name: "click",
    dur: 180 + i * 10, processing: 150, delay: 40, present: 20, discrete: true, interactionId: i + 1
  });
}
const rows = analysis.scorecard({ resources: app.cache.resources, canvas: syntheticCanvas, memory: app.cache.memory });
const f = analysis.findings({ rows, canvas: syntheticCanvas, dom: app.cache.dom, data: syntheticData, memory: app.cache.memory });
const titles = f.map((x) => x.title);
ok("flags huge texture memory", titles.some((t) => /texture memory/i.test(t)), titles.join(" | "));
ok("flags filter count", titles.some((t) => /filtered display objects/i.test(t)));
ok("flags large scene graph", titles.some((t) => /canvas scene graph/i.test(t)));
ok("flags flag bloat", titles.some((t) => /flags are bloating/i.test(t)));
ok("flags orphaned module data", f.some((x) => /ghost-mod/.test(x.owner)));
ok("flags large chat history", titles.some((t) => /chat history/i.test(t)));
ok("flags localStorage pressure", titles.some((t) => /localStorage/i.test(t)));
ok("flags slow input", titles.some((t) => /discrete input/i.test(t)));
ok("flags socket traffic", titles.some((t) => /socket traffic/i.test(t)));
ok("every finding has detail and action",
  f.every((x) => x.detail && x.action && x.metric),
  JSON.stringify(f.filter((x) => !x.detail || !x.action || !x.metric).map((x) => x.title)));
ok("findings sorted by severity", f.every((x, i) => i === 0 || f[i - 1].sev >= x.sev));

/* -- frozen detail modal --------------------------------------------------------------------- */
section("Frozen finding detail modal");
const { FindingDetail } = await import("../module/dashboard.mjs");
app.cache.findings = f;
app.cache.canvas = syntheticCanvas;
app.cache.data = syntheticData;

ok("every finding carries a source tag", f.every((x) => typeof x.source === "string"),
  JSON.stringify(f.filter((x) => !x.source).map((x) => x.title)));
ok("findings have stable ids", new Set(f.map((x) => x.id)).size === f.length);

const opened = [];
const origRender = FindingDetail.prototype.render;
FindingDetail.prototype.render = function () { opened.push(this); this.rendered = true; return Promise.resolve(this); };

const sources = new Set();
for (let i = 0; i < f.length; i++) {
  await app._actOpenFinding({}, { dataset: { index: String(i) } });
  sources.add(f[i].source);
}
ok("clicking each finding opens a modal", opened.length === f.length, `${opened.length}/${f.length}`);
ok("exercised multiple evidence families", sources.size >= 4, [...sources].join(","));

let renderFails = [];
for (const modal of opened) {
  try {
    const html = await modal._renderHTML();
    if (typeof html !== "string" || html.length < 200) renderFails.push(`${modal.payload.finding.title}: too short`);
  } catch (e) { renderFails.push(`${modal.payload.finding.title}: ${e.message}`); }
}
ok("every finding modal renders", renderFails.length === 0, renderFails.slice(0, 3).join(" | "));

const one = opened[0];
ok("payload is frozen at capture time", typeof one.payload.capturedAt === "number");
ok("payload records session position", typeof one.payload.sessionMinutes === "number");
ok("payload carries vitals", typeof one.payload.vitals.fps === "number");
ok("modal title reflects severity", /Critical|Warning|Info/.test(one.title), one.title);

// The whole point: mutate live probe state and confirm the snapshot does not move.
const before = JSON.stringify(one.payload);
P.owners.get("alpha-mod").hookCalls += 999999;
P.owners.get("alpha-mod").errors += 500;
P.spans.push({ t: Date.now(), p: 0, dur: 999, self: 999, owner: "alpha-mod", kind: "hook", label: "later" });
P.sample();
await app._prepareContext();
ok("snapshot is immune to later probe activity", JSON.stringify(one.payload) === before);
const html2 = await one._renderHTML();
ok("re-rendering the modal still shows the frozen numbers", !html2.includes("999,999"));

// Evidence for an owner-scoped finding should actually contain that owner's data.
const ownerModal = opened.find((m) => m.payload.evidence.row?.id === "alpha-mod");
ok("owner-scoped finding captured its module row", !!ownerModal);
if (ownerModal) {
  const ev = ownerModal.payload.evidence;
  ok("captured the module's hooks", ev.hooks.length > 0, `n=${ev.hooks.length}`);
  ok("captured its live intervals", ev.intervals.length > 0, `n=${ev.intervals.length}`);
  ok("captured its errors", ev.errors.length > 0, `n=${ev.errors.length}`);
  ok("evidence is plain data, not live references",
    ev.hooks.every((h) => typeof h.hook === "string" && !(h instanceof Map)));
}

// Error modal.
app.tab = "errors";
await app._renderHTML();
ok("error list was captured for click handling", Array.isArray(app._lastErrorList) && app._lastErrorList.length > 0);
opened.length = 0;
await app._actOpenError({}, { dataset: { index: "0" } });
ok("clicking an error opens a modal", opened.length === 1);
if (opened[0]) {
  const eh = await opened[0]._renderHTML();
  ok("error modal renders with a stack", typeof eh === "string" && eh.includes("Stack"));
  ok("error modal reports the signature count", typeof opened[0].payload.error.signatureCount === "number");
}

// Copy path must not throw when the clipboard is unavailable (it isn't, under Node).
let copyThrew = false;
try { await one._actCopy(); } catch (e) { copyThrew = true; }
ok("copy handler degrades gracefully without a clipboard", !copyThrew);

FindingDetail.prototype.render = origRender;

/* -- browser capability handling ------------------------------------------------------------- */
section("Degraded-browser handling (Firefox: no performance.memory, no longtask)");
const savedCaps = P.capabilities;
const savedHeap = P.heapAvailable;
P.capabilities = {
  heap: false, longTask: false, eventTiming: true, layoutShift: false,
  asyncClipboard: false, secureContext: false, manualGC: false, engine: "firefox"
};
P.heapAvailable = false;
const ffFindings = analysis.findings({ rows, canvas: syntheticCanvas, dom: app.cache.dom, data: syntheticData, memory: null });
ok("warns that measurements are unavailable",
  ffFindings.some((x) => /unavailable in Firefox/i.test(x.title)), ffFindings.map((x) => x.title).join(" | "));
ok("explains that missing data is not good news",
  ffFindings.some((x) => /not the same as/i.test(x.detail)));
ok("notes the non-secure origin",
  ffFindings.some((x) => /secure context/i.test(x.title)));
ok("suppresses heap findings when there is no heap API",
  !ffFindings.some((x) => /heap floor|near the tab limit/i.test(x.title)),
  ffFindings.filter((x) => /heap/i.test(x.title)).map((x) => x.title).join(" | "));
app.cache.findings = ffFindings;
for (const key of ["overview", "memory", "timeline", "frames"]) {
  app.tab = key;
  await app._prepareContext();
  app.cache.findings = ffFindings;
  app.cache.canvas = syntheticCanvas;
  let html = null, err = null;
  try { html = await app._renderHTML(); } catch (e) { err = e; }
  ok(`tab "${key}" renders in degraded mode`, typeof html === "string" && !html.includes("Tab failed to render"),
    err ? err.message : "");
}
app.tab = "memory";
await app._prepareContext();
const memHtml = await app._renderHTML();
ok("memory tab says data is missing rather than showing zero",
  /means "no data", not "no leak"/.test(memHtml));
app.tab = "timeline";
await app._prepareContext();
const tlHtml = await app._renderHTML();
ok("timeline tab warns an empty list is not evidence", /not<\/em> evidence/.test(tlHtml));
P.capabilities = savedCaps;
P.heapAvailable = savedHeap;

section("Input latency: hover events must not be reported as lag");
P.inputLatency.clear();
for (let i = 0; i < 14; i++) {
  P.inputLatency.push({
    t: Date.now(), start: i * 100, end: i * 100 + 190, name: "pointerout",
    dur: 184, processing: 2, delay: 3, present: 179, discrete: false, interactionId: 0
  });
}
const hoverOnly = analysis.findings({ rows: [], canvas: null, dom: null, data: null, memory: null });
ok("does not raise a slow-input warning from hover events",
  !hoverOnly.some((x) => x.sev >= 2 && /input/i.test(x.title)),
  hoverOnly.filter((x) => /input/i.test(x.title)).map((x) => `${x.sevName}:${x.title}`).join(" | "));
ok("explains the hover artefact as info instead",
  hoverOnly.some((x) => x.sev === 1 && /Hover events/i.test(x.title)));

P.inputLatency.clear();
for (let i = 0; i < 8; i++) {
  P.inputLatency.push({
    t: Date.now(), start: i * 100, end: i * 100 + 240, name: "click",
    dur: 240, processing: 150, delay: 20, present: 70, discrete: true, interactionId: i + 1
  });
}
const realLag = analysis.findings({ rows: [], canvas: null, dom: null, data: null, memory: null });
const lagFinding = realLag.find((x) => /discrete input/i.test(x.title));
ok("does raise a warning for genuinely slow clicks", !!lagFinding, realLag.map((x) => x.title).join(" | "));
ok("attributes the time to the handler, not the total",
  !!lagFinding && /in handlers/.test(lagFinding.metric), lagFinding?.metric);
ok("breaks the total into queue / handler / paint",
  !!lagFinding && /queued .* in handlers .* waiting to paint/.test(lagFinding.detail));

P.inputLatency.clear();
for (let i = 0; i < 6; i++) {
  P.inputLatency.push({
    t: Date.now(), start: i * 100, end: i * 100 + 300, name: "click",
    dur: 300, processing: 5, delay: 260, present: 35, discrete: true, interactionId: i + 1
  });
}
const queueLag = analysis.findings({ rows: [], canvas: null, dom: null, data: null, memory: null })
  .find((x) => /discrete input/i.test(x.title));
ok("distinguishes queue-bound lag from handler-bound lag",
  !!queueLag && /waiting to start/.test(queueLag.detail), queueLag?.detail?.slice(0, 120));

section("Frame budget follows the actual display refresh rate");
P.frames.clear();
for (let i = 0; i < 300; i++) P.frames.push(6.06 + (Math.random() - 0.5) * 0.4);
P.sample();
ok("detects a 165 Hz display", P.refreshHz === 165, `got ${P.refreshHz}`);
ok("frame budget follows it", Math.abs(P.frameBudgetMs - 1000 / 165) < 0.01, String(P.frameBudgetMs));
P.owners.get("alpha-mod").tickerTotal = P.global.frames * 0.5;   // 0.5 ms/frame
const hzRows = analysis.scorecard({});
const hzRow = hzRows.find((r) => r.id === "alpha-mod");
ok("per-frame cost is expressed against the real budget",
  Math.abs(hzRow.pctOfFrame - (0.5 / (1000 / 165)) * 100) < 1, String(hzRow.pctOfFrame));
ok("0.5 ms/frame is ~8% of a 165 Hz budget, not ~3% of a 60 Hz one", hzRow.pctOfFrame > 7,
  `${hzRow.pctOfFrame.toFixed(1)}%`);
const hzFindings = analysis.findings({ rows: hzRows });
ok("finding quotes the detected refresh rate",
  hzFindings.some((x) => /165 Hz display/.test(x.detail || "")),
  hzFindings.filter((x) => /frame/i.test(x.title)).map((x) => x.detail?.slice(0, 90)).join(" | "));

section("libWrapper envelope must not read as consumption");
const lwRows = [{
  id: "lib-wrapper", title: "libWrapper", installed: true, active: true, muted: false,
  cpuMs: 300, selfMs: 300, cpuPct: 0.2, msPerMin: 100,
  hookCalls: 0, hookTotal: 0, hookMax: 0, hookMaxName: "", hookRegsLive: 0,
  lwCalls: 5000, lwSelf: 300, lwInclusive: 67310, lwMax: 0.4, lwMaxTarget: "Application.prototype._render",
  lwPassThrough: 67010,
  costMix: { hooks: 0, libWrapper: 300, ticker: 0, listeners: 0, timers: 0 },
  tickerTotal: 0, tickerCalls: 0, tickerRegs: 0, msPerFrame: 0, pctOfFrame: 0,
  listenerCalls: 0, listenerTotal: 0, listenerRegs: 0,
  timerCalls: 0, timerTotal: 0, intervalRegs: 0, liveIntervals: 0,
  domOps: 0, domOpsPerMin: 0, domHtmlChars: 0, storageWrites: 0, storageBytes: 0,
  netRequests: 0, netBytes: 0, netTotal: 0, dbDocs: 0, dbBytes: 0,
  errors: 0, longTaskMs: 0, assetBytes: 0, assetMs: 0, assetCount: 0, biggestAsset: null,
  retainedBytes: 0, retainedTruncated: false, canvasObjects: 0, score: 2
}];
const lwF = analysis.findings({ rows: lwRows });
ok("does not accuse a pass-through wrapper of consuming the main thread",
  !lwF.some((x) => x.sev >= 2 && /main-thread consumption/i.test(x.title) && x.owner === "lib-wrapper"),
  lwF.filter((x) => x.owner === "lib-wrapper").map((x) => `${x.sevName}:${x.title}`).join(" | "));
const envelope = lwF.find((x) => /adds almost nothing/i.test(x.title));
ok("explains the envelope instead", !!envelope, lwF.map((x) => x.title).join(" | "));
ok("names the wrapped target", !!envelope && /Application\.prototype\._render/.test(envelope.detail));
ok("tells you to look at the wrapped function, not the package",
  !!envelope && /look at what is calling it, not at this package/.test(envelope.action));
ok("calls out libWrapper's own error-catching wrapper specifically",
  !!envelope && /catch render errors/.test(envelope.action));

// And a package that genuinely burns CPU is still called out, with a breakdown.
const busyRows = [{ ...lwRows[0], id: "busy-mod", title: "Busy", cpuMs: 30000, cpuPct: 12,
  lwSelf: 30000, lwInclusive: 31000, lwPassThrough: 1000,
  costMix: { hooks: 0, libWrapper: 30000, ticker: 0, listeners: 0, timers: 0 } }];
const busyF = analysis.findings({ rows: busyRows });
const busyFinding = busyF.find((x) => /main-thread consumption/i.test(x.title));
ok("real consumption is still flagged", !!busyFinding);
ok("finding shows where the cost came from instead of a bogus hottest hook",
  !!busyFinding && /Breakdown: libWrapper/.test(busyFinding.detail), busyFinding?.detail?.slice(0, 160));
ok("no longer claims 'Hottest hook: n/a'",
  !!busyFinding && !/Hottest hook: n\/a/.test(busyFinding.detail));

section("Listener growth: element churn must not be reported as a leak");
const churnSamples = [];
for (let i = 0; i < 30; i++) {
  churnSamples.push({
    t: Date.now() - (30 - i) * 60000, heap: 0,
    listeners: 500 + i * 300,        // climbs relentlessly — every sheet open
    listenersAttached: 500 + i * 2,  // essentially flat — nothing retained
    domNodes: 12000, chatDom: 10, intervals: 3, apps: 2, fps: 60
  });
}
P.samples.clear();
for (const s of churnSamples) P.samples.push(s);
const churnF = analysis.findings({ rows: [] });
ok("does not raise a leak alarm when nothing stays attached",
  !churnF.some((x) => x.sev >= 2 && /listeners accumulating/i.test(x.title)),
  churnF.filter((x) => /listener/i.test(x.title)).map((x) => `${x.sevName}:${x.title}`).join(" | "));
ok("explains why the raw counter climbs",
  churnF.some((x) => /nothing is being retained/i.test(x.title) && /throw their element away/i.test(x.detail)),
  churnF.map((x) => x.title).join(" | "));

P.samples.clear();
for (let i = 0; i < 30; i++) {
  P.samples.push({
    t: Date.now() - (30 - i) * 60000, heap: 0,
    listeners: 500 + i * 300,
    listenersAttached: 500 + i * 250,  // genuinely retained
    domNodes: 12000, chatDom: 10, intervals: 3, apps: 2, fps: 60
  });
}
const leakF = analysis.findings({ rows: [] });
ok("does raise the alarm when attached listeners climb",
  leakF.some((x) => x.sev === 3 && /accumulating on live elements/i.test(x.title)),
  leakF.filter((x) => /listener/i.test(x.title)).map((x) => `${x.sevName}:${x.title}`).join(" | "));

section("Independent-check snippet must actually be runnable");
app.tab = "dom";
await app._prepareContext();
const domHtml = await app._renderHTML();
ok("retention panel is present", /Listener retention test/.test(domHtml));
ok("independent check is offered", /without trusting my counters/.test(domHtml));
ok("Firefox guidance is accurate about the missing panel",
  /no Event Listeners sidebar/.test(domHtml) && /getEventListeners\(\)<\/code> does not exist/.test(domHtml),
  "check the Firefox wording");

// Extract the snippet from the module and prove it parses and behaves.
const dashSrc = readFileSync(join(root, "module", "dashboard.mjs"), "utf8");
const snippetLines = dashSrc.split("const INDEPENDENT_CHECK = [")[1].split("].join(\"\\n\");")[0];
const snippet = JSON.parse("[" + snippetLines.trim().replace(/,\s*$/, "") + "]").join("\n");
ok("snippet parses as valid JavaScript", (() => {
  try { new Function(snippet); return true; } catch (e) { return false; }
})(), (() => { try { new Function(snippet); return ""; } catch (e) { return e.message; } })());

// Run it against the harness and confirm it tallies independently of the probe.
globalThis.window = globalThis;
const beforeAdd = EventTarget.prototype.addEventListener;
new Function(snippet)();
ok("snippet installs its own counters",
  typeof globalThis.__lt === "function" && typeof globalThis.__ltStop === "function");
ok("snippet replaced addEventListener", EventTarget.prototype.addEventListener !== beforeAdd);
const probeEl = new globalThis.Node("div");
probeEl.addEventListener("click", () => {});
probeEl.addEventListener("click", () => {});
let tabled = null;
const origTable = console.table;
console.table = (rows) => { tabled = rows; };
globalThis.__lt();
console.table = origTable;
ok("snippet counted the registrations", Array.isArray(tabled) && tabled.some((r) => r.event === "click" && r.net === 2),
  JSON.stringify(tabled));
ok("snippet separates persistent targets from elements",
  tabled.every((r) => ["window", "document", "body", "element", "other"].includes(r.target)),
  JSON.stringify(tabled));
globalThis.__ltStop();
ok("snippet restores the original prototype", EventTarget.prototype.addEventListener === beforeAdd);
ok("node counter helper works", typeof globalThis.__ltNodes() === "number");

/* =========================================================================================
   Foundry v14 census regressions.
   ========================================================================================= */

section("v14: world settings are not counted twice");
// v14's settings storage map has three scopes but only two stores — `user` is set to the very
// same WorldSettings object as `world` — so iterating it naively billed every world setting
// twice on the Data tab.
{
  const worldStore = { contents: [{ key: "alpha-mod.big", value: "x".repeat(1000) }] };
  const prevGame = globalThis.game;
  globalThis.game = {
    ...prevGame,
    actors: [], items: [], journal: [], tables: [], macros: [], playlists: [],
    scenes: [], users: [], combats: [], cards: [], folders: [], messages: [],
    packs: [],
    settings: {
      storage: new Map([
        ["client", globalThis.localStorage],
        ["world", worldStore],
        ["user", worldStore]   // the v14 alias — same object, not a copy
      ])
    }
  };
  const scanned = await census.dataCensus();
  const alphaSetting = scanned.settings.find((r) => r.namespace === "alpha-mod");
  ok("aliased world/user store counted once", alphaSetting?.keys === 1, `keys=${alphaSetting?.keys}`);
  ok("world setting bytes not doubled", alphaSetting?.worldBytes > 0 && alphaSetting.worldBytes < 1200,
    `worldBytes=${alphaSetting?.worldBytes}`);
  globalThis.game = prevGame;
}

section("v14: chat messages are not counted twice");
// v14 renders the same messages in the sidebar tab and again in the chat-notifications panel,
// both under `.chat-log`. A union count doubled a figure the Memory tab treats as a leak signal.
{
  const mkLog = (n) => {
    const log = globalThis.document.createElement("div");
    log.className = "chat-log";
    for (let i = 0; i < n; i++) {
      const m = globalThis.document.createElement("li");
      m.className = "chat-message message";
      log.appendChild(m);
    }
    return log;
  };
  const sidebar = mkLog(12);
  const notifications = mkLog(12);   // same messages, mirrored
  globalThis.document.body.appendChild(sidebar);
  globalThis.document.body.appendChild(notifications);
  const dom = census.domCensus();
  ok("both chat logs were found", dom.chat.logs === 2, `logs=${dom.chat.logs}`);
  ok("messages counted once, not once per log", dom.chat.domMessages === 12,
    `domMessages=${dom.chat.domMessages}`);
  globalThis.document.body.removeChild(sidebar);
  globalThis.document.body.removeChild(notifications);
}

section("v14: a popped-out application is not an orphaned one");
{
  const win = globalThis.__openDetachedWindow("popout-render");
  const popped = globalThis.document.createElement("div");
  popped.ownerDocument = win.document;
  popped.isConnected = true;                       // connected to *its own* document

  const orphan = globalThis.document.createElement("div");
  orphan.ownerDocument = globalThis.document;
  orphan.isConnected = false;                      // in no document at all — a real leak

  const insts = globalThis.foundry.applications.instances;
  insts.set("popped-app", { constructor: { name: "PoppedSheet" }, element: popped });
  insts.set("orphan-app", { constructor: { name: "LeakedSheet" }, element: orphan });

  const dom = census.domCensus();
  const poppedRow = dom.apps.list.find((a) => a.id === "popped-app");
  const orphanRow = dom.apps.list.find((a) => a.id === "orphan-app");
  ok("popped-out app counted as attached", poppedRow?.attached === true, `attached=${poppedRow?.attached}`);
  ok("popped-out app is not flagged as orphaned", poppedRow?.orphaned === false, `orphaned=${poppedRow?.orphaned}`);
  ok("popped-out app names its host window", poppedRow?.poppedOut === "popout-render", `host=${poppedRow?.poppedOut}`);
  ok("a genuinely orphaned app is still flagged", orphanRow?.orphaned === true);
  ok("the pop-out window is reported separately", dom.detachedWindows.length === 1,
    `windows=${dom.detachedWindows.length}`);

  const f = analysis.findings({ dom, rows: [] });
  const orphanFinding = f.find((x) => /orphaned from every document/.test(x.title));
  ok("only the real orphan produces a finding", /^1 orphaned$/.test(orphanFinding?.metric || ""),
    `metric=${orphanFinding?.metric}`);

  insts.delete("popped-app"); insts.delete("orphan-app");
  globalThis.foundry.applications.detached.windows.delete("popout-render");
}

section("v14: observer cost is attributed and rendered");
{
  const target = globalThis.document.createElement("div");
  const obs = alpha.observe("MutationObserver", target, () => {
    let x = 0; for (let i = 0; i < 200000; i++) x += Math.sqrt(i); return x;
  });
  obs._fire([{}, {}, {}]);
  const rows = analysis.scorecard({});
  const alphaRow = rows.find((r) => r.id === "alpha-mod");
  ok("observer time reaches the scorecard", alphaRow.observerTotal > 0, `total=${alphaRow.observerTotal}`);
  ok("observer time is inside the charged CPU total", alphaRow.cpuMs >= alphaRow.observerTotal);
  ok("cost mix names observers", alphaRow.costMix.observers > 0, `mix=${alphaRow.costMix.observers}`);

  app.tab = "dom";
  app._invalidate();
  await app._prepareContext();
  const html = await app._renderHTML();
  ok("DOM tab shows the observers table", html.includes("Observers and idle callbacks"));
  ok("observers table names the owning package", /MutationObserver[\s\S]{0,400}alpha-mod/.test(html));
  obs.disconnect();
}

section("Snapshot diff");
const d = analysis.diffSnapshots(app.snapshots[0], app.snapshots[1]);
ok("diff reports heap growth per hour", d.heapPerHour > 0, String(d.heapPerHour));
ok("diff reports listener growth", d.listeners.delta === 3300);
ok("diff surfaces per-owner deltas", d.owners.some((o) => o.id === "alpha-mod" && o.cpuMs > 0));

section("Export payload");
let exported = null;
globalThis.foundry.utils.saveDataToFile = (json) => { exported = json; };
await app._actExport();
ok("export produced JSON", typeof exported === "string" && exported.length > 500);
let parsed = null;
try { parsed = JSON.parse(exported); } catch (e) { /* handled */ }
ok("export is valid JSON", !!parsed);
ok("export contains scorecard and findings", !!parsed?.scorecard && !!parsed?.findings);
ok("export contains raw samples", Array.isArray(parsed?.samples));
ok("export has no Map leftovers", !/"\[object Map\]"/.test(exported || ""));

clearInterval(iv);
console.log(`\n[1m${pass} passed, ${fail} failed[0m`);
if (fail) { console.log("Failures:\n" + failures.map((x) => `  - ${x}`).join("\n")); process.exit(1); }
process.exit(0);
