/**
 * Probe test suite.
 *   node --experimental-vm-modules test/run.mjs
 *
 * Exercises the instrumentation against a minimal harness: attribution by stack, self vs total
 * timing, mute, leak registries, and every patched surface.
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
  if (cond) { pass++; console.log(`  [32m✓[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  [31m✗[0m ${name} ${extra}`); }
}
function section(t) { console.log(`\n[1m${t}[0m`); }

/* -- boot ---------------------------------------------------------------------------------- */
const harness = installHarness();

// Execute the probe as a classic script, with a filename that mimics its real served path so
// the probe's own self-frame filter behaves exactly as it does in Foundry.
const probeSrc = readFileSync(join(root, "scripts", "dmm-probe.js"), "utf8");
vm.runInThisContext(probeSrc, { filename: "http://localhost:30000/modules/dmm-performance-checker/scripts/dmm-probe.js" });

const P = globalThis.DMMPC;

section("Installation");
ok("probe installed", !!P?.installed);
ok("armed", P.armed === true);
ok("patched Hooks before any registration (early)", P.early === true, `preExisting=${P.preExisting}`);
ok("captured baseline globals", P.baselineGlobals instanceof Set);

/* -- load fixture modules ------------------------------------------------------------------ */
const alpha = await import("./fixtures/modules/alpha-mod/main.mjs");
const beta = await import("./fixtures/modules/beta-mod/main.mjs");

section("Hook attribution and timing");
alpha.register();
beta.register();

ok("alpha hook attributed", P.hooks.has("testHook alpha-mod"),
  `keys=${[...P.hooks.keys()].join(" | ")}`);
ok("beta hook attributed", P.hooks.has("innerHook beta-mod"),
  `keys=${[...P.hooks.keys()].join(" | ")}`);

Hooks.callAll("testHook", 30000);
const a = P.hooks.get("testHook alpha-mod");
const b = P.hooks.get("innerHook beta-mod");
ok("alpha call counted", a?.calls === 1, `calls=${a?.calls}`);
ok("alpha total > 0", a?.total > 0, `total=${a?.total}`);
ok("beta ran nested", b?.calls === 1, `calls=${b?.calls}`);
ok("alpha self < alpha total (nested time excluded)", a.self < a.total,
  `self=${a.self.toFixed(3)} total=${a.total.toFixed(3)}`);
ok("alpha self excludes roughly beta's time",
  Math.abs((a.total - a.self) - b.total) < Math.max(2, b.total * 0.6),
  `total-self=${(a.total - a.self).toFixed(3)} beta=${b.total.toFixed(3)}`);
ok("context stack unwound cleanly", P.ctx.length === 0, `depth=${P.ctx.length}`);
ok("hook envelope recorded", P.hookEnvelope.get("testHook")?.calls === 1);
ok("owner rollup for alpha", P.owners.get("alpha-mod").hookCalls === 1);

section("Hooks.off by original function reference");
const namedFn = () => {};
alpha.registerNamed(namedFn);
const beforeLive = P.hooks.get("namedHook alpha-mod").live;
Hooks.off("namedHook", namedFn);
Hooks.callAll("namedHook");
ok("off() translated wrapped fn and removed it",
  (Hooks.events["namedHook"] || []).length === 0,
  `remaining=${(Hooks.events["namedHook"] || []).length}`);
ok("live registration count decremented",
  P.hooks.get("namedHook alpha-mod").live === beforeLive - 1);

section("Hooks.once");
let onceCount = 0;
Hooks.once("onceHook", () => { onceCount++; });
Hooks.callAll("onceHook");
Hooks.callAll("onceHook");
ok("once fired exactly once", onceCount === 1, `count=${onceCount}`);

section("Muting");
P.mute("alpha-mod");
const callsBefore = P.hooks.get("testHook alpha-mod").calls;
const betaBefore = P.hooks.get("innerHook beta-mod").calls;
Hooks.callAll("testHook", 5000);
ok("muted module's callback did not run",
  P.hooks.get("testHook alpha-mod").calls === callsBefore);
ok("mute counter incremented", P.hooks.get("testHook alpha-mod").muted === 1);
ok("muting alpha also suppressed the nested dispatch it triggers",
  P.hooks.get("innerHook beta-mod").calls === betaBefore);
P.unmute("alpha-mod");
Hooks.callAll("testHook", 5000);
ok("unmute restores execution", P.hooks.get("testHook alpha-mod").calls === callsBefore + 1);

section("Timers");
const iv = alpha.startInterval(50);
ok("interval registered with owner", P.liveIntervals.get(iv)?.owner === "alpha-mod",
  `owner=${P.liveIntervals.get(iv)?.owner}`);
ok("interval delay recorded", P.liveIntervals.get(iv)?.delay === 50);
ok("owner interval counter", P.owners.get("alpha-mod").intervalRegs >= 1);
await new Promise((r) => setTimeout(r, 130));
ok("interval fires counted", P.liveIntervals.get(iv)?.fires >= 2,
  `fires=${P.liveIntervals.get(iv)?.fires}`);
clearInterval(iv);
ok("clearInterval removes from live registry", !P.liveIntervals.has(iv));

const th = beta.scheduleTimeout(() => {}, 5);
ok("timeout registered with owner", P.liveTimeouts.get(th)?.owner === "beta-mod",
  `owner=${P.liveTimeouts.get(th)?.owner}`);
await new Promise((r) => setTimeout(r, 30));
ok("timeout self-removes from live registry after firing", !P.liveTimeouts.has(th));

section("Event listeners");
const target = new EventTarget();
let listenerRan = 0;
const listener = () => { listenerRan++; };
alpha.addListener(target, "click", listener);
ok("listener registration attributed", P.listeners.has("click alpha-mod"),
  `keys=${[...P.listeners.keys()].join(" | ")}`);
target.dispatchEvent(new Event("click"));
ok("listener ran through wrapper", listenerRan === 1);
ok("listener invocation counted", P.listeners.get("click alpha-mod").calls === 1);
target.removeEventListener("click", listener);
target.dispatchEvent(new Event("click"));
ok("removeEventListener unwrapped correctly", listenerRan === 1);
ok("live listener count decremented", P.listeners.get("click alpha-mod").live === 0);

section("DOM and storage attribution via context stack");
const domBefore = P.owners.get("alpha-mod").domOps;
alpha.registerDomHook(document.body, 25);
Hooks.callAll("domHook");
const domAfter = P.owners.get("alpha-mod").domOps;
ok("DOM mutations attributed to the owning callback", domAfter - domBefore >= 26,
  `delta=${domAfter - domBefore}`);
ok("innerHTML characters recorded", P.owners.get("alpha-mod").domHtmlChars > 0);
ok("DOM ops are not misattributed to the test runner",
  (P.owners.get("unattributed")?.domOps ?? 0) === 0,
  `unattributed=${P.owners.get("unattributed")?.domOps}`);

alpha.registerStorageHook(10);
Hooks.callAll("storeHook");
ok("localStorage writes attributed", P.owners.get("alpha-mod").storageWrites >= 10,
  `writes=${P.owners.get("alpha-mod").storageWrites}`);
ok("localStorage bytes recorded", P.owners.get("alpha-mod").storageBytes > 0);

section("PIXI ticker");
const ticker = new PIXI.Ticker();
alpha.tickerWork(ticker);
ok("ticker registration attributed", P.ticker.has("alpha-mod"),
  `keys=${[...P.ticker.keys()].join(" | ")}`);
ticker.tick(1); ticker.tick(1); ticker.tick(1);
ok("ticker invocations counted", P.ticker.get("alpha-mod").calls === 3,
  `calls=${P.ticker.get("alpha-mod").calls}`);
ok("ticker time recorded", P.ticker.get("alpha-mod").total > 0);
ok("ticker function name captured", P.ticker.get("alpha-mod").fns.has("alphaTick"));

section("Database writes");
alpha.registerDbHook();
Hooks.callAll("dbHook");
await new Promise((r) => setTimeout(r, 10));
ok("db operation attributed", P.db.get("alpha-mod")?.updates === 1,
  `db=${JSON.stringify([...P.db.keys()])}`);
ok("db document count recorded", P.db.get("alpha-mod")?.docs === 2);
ok("db payload bytes recorded", P.db.get("alpha-mod")?.bytes > 0);

section("Errors");
alpha.throwingHook();
let threw = false;
try { Hooks.callAll("boomHook"); } catch (e) { threw = true; }
ok("error propagated to caller (probe does not swallow)", threw);
ok("error attributed to module", P.owners.get("alpha-mod").errors >= 1);
ok("error signature recorded", [...P.errorSignatures.keys()].some((k) => k.startsWith("alpha-mod|")),
  `sigs=${[...P.errorSignatures.keys()].join(" | ")}`);
ok("context stack unwound after a throw", P.ctx.length === 0, `depth=${P.ctx.length}`);

section("libWrapper: pass-through wrappers must not be billed for what they wrap");
// Reproduces the real-world case: libWrapper registers a pure error-catching WRAPPER on
// Application.prototype._render under its own package id, so without exclusive accounting every
// application render in the session gets billed to "lib-wrapper".
beta.registerPassThroughWrapper("lib-wrapper");
const expensiveOriginal = () => { let x = 0; for (let i = 0; i < 400000; i++) x += Math.sqrt(i); return x; };
for (let i = 0; i < 3; i++) libWrapper._invoke("Application.prototype._render", expensiveOriginal);

const lwList = P.libWrapper.get("Application.prototype._render") || [];
const lwRec = lwList.find((r) => r.owner === "lib-wrapper");
ok("pass-through wrapper was instrumented", !!lwRec, `n=${lwList.length}`);
ok("its envelope captured the expensive downstream call", lwRec.inclusive > 1,
  `inclusive=${lwRec?.inclusive?.toFixed(2)}`);
ok("its own cost is near zero", lwRec.self < lwRec.inclusive * 0.15,
  `self=${lwRec.self.toFixed(3)} inclusive=${lwRec.inclusive.toFixed(2)}`);
const lwOwner = P.owners.get("lib-wrapper");
ok("owner is charged the exclusive cost, not the envelope",
  lwOwner.lwSelf < lwOwner.lwInclusive * 0.15,
  `self=${lwOwner.lwSelf.toFixed(3)} inclusive=${lwOwner.lwInclusive.toFixed(2)}`);
ok("libWrapper cost does not masquerade as hook cost", lwOwner.hookCalls === 0 && lwOwner.hookMax === 0,
  `hookCalls=${lwOwner.hookCalls} hookMax=${lwOwner.hookMax}`);
ok("context stack unwound through the wrapper chain", P.ctx.length === 0);

// A wrapper that genuinely works should be charged for that work.
beta.registerBusyWrapper("alpha-mod", 300000);
for (let i = 0; i < 3; i++) libWrapper._invoke("Application.prototype._render", expensiveOriginal);
const busyRec = (P.libWrapper.get("Application.prototype._render") || []).find((r) => r.owner === "alpha-mod");
ok("a wrapper doing real work is charged for it", busyRec && busyRec.self > 1,
  `self=${busyRec?.self?.toFixed(2)}`);
ok("...but still not for the downstream chain", busyRec.self < busyRec.inclusive,
  `self=${busyRec.self.toFixed(2)} inclusive=${busyRec.inclusive.toFixed(2)}`);
ok("nested wrappers do not double-count downstream time",
  lwRec.self < lwRec.inclusive * 0.2,
  `after nesting: self=${lwRec.self.toFixed(3)} inclusive=${lwRec.inclusive.toFixed(2)}`);

section("Listener retention: closing a sheet must not look like a leak");
P.listeners.clear();
let sheetEls = beta.attachSheetListeners(() => {
  const el = new globalThis.Node("div");
  el.isConnected = true;
  return el;
}, 300);
P.sweepListeners();
const lrec = P.listeners.get("click beta-mod");
ok("registrations recorded", lrec && lrec.regs === 300, `regs=${lrec?.regs}`);
ok("all are attached while the sheet is open", lrec.attached === 300, `attached=${lrec.attached}`);

// Close the sheet: Foundry discards the element without calling removeEventListener.
for (const el of sheetEls) el.isConnected = false;
P.sweepListeners();
ok("'not removed' still counts them — which is why it is a bad signal", lrec.live === 300, `live=${lrec.live}`);
ok("'attached' correctly drops to zero once the element leaves the document",
  lrec.attached === 0, `attached=${lrec.attached}`);
ok("they are counted as collected, not leaked", lrec.orphaned === 300, `orphaned=${lrec.orphaned}`);
sheetEls = null;

// A listener on document survives an application close — that IS the leak-shaped case.
P.listeners.clear();
beta.attachSheetListeners(() => globalThis.document, 5);
P.sweepListeners();
const wrec = P.listeners.get("click beta-mod");
ok("listeners on a persistent target stay attached", wrec && wrec.attached === 5, `attached=${wrec?.attached}`);
ok("...and are not counted as collected", wrec.orphaned === 0, `orphaned=${wrec.orphaned}`);
ok("attached targets are broken down by kind", wrec.attachedBy.length > 0,
  JSON.stringify(wrec.attachedBy));
ok("a registration stack is captured for locating the code", wrec.sampleStacks.size > 0);

section("Listener budget exhaustion must not fake a leak");
// Regression: `untracked` is cumulative and never decreases. Including it in the attached total
// made that total monotonically increasing once the WeakRef budget ran out — the profiler
// reproducing the exact symptom it exists to diagnose.
P.listeners.clear();
const brec = listenerRecFor("click", "beta-mod");
function listenerRecFor(type, owner) {
  // Force a record into existence through the public path.
  const el = new globalThis.Node("div");
  el.isConnected = true;
  beta.attachSheetListeners(() => el, 1);
  return P.listeners.get(`${type} ${owner}`);
}
brec.untracked = 25000;      // simulate a long session that blew the budget
P.sweepListeners();
const attachedTotal = P.samples.push(null) && 0; // no-op to keep lint quiet
P.samples.clear();
P.sample();
const lastSample = P.samples.toArray().pop();
ok("untracked registrations are excluded from the attached total",
  lastSample.listenersAttached < 100,
  `listenersAttached=${lastSample.listenersAttached} untracked=${brec.untracked}`);
ok("coverage is reported honestly instead", P.listenerCoverage < 0.5,
  `coverage=${P.listenerCoverage}`);
void attachedTotal;

section("Listener retention baseline (the verification workflow)");
P.listeners.clear();
P.clearListenerBaseline();
P.markListenerBaseline();
// Open a "sheet": 200 listeners on elements that will be discarded.
let sheet2 = beta.attachSheetListeners(() => { const el = new globalThis.Node("div"); el.isConnected = true; return el; }, 200);
// ...and 4 on a persistent target, which is the leak-shaped case.
beta.attachSheetListeners(() => globalThis.document, 4);
let rd = P.listenerDelta();
ok("baseline sees the registrations", rd.rows[0].regsDelta === 204, `regs=${rd.rows[0]?.regsDelta}`);
ok("all attached while open", rd.rows[0].attachedDelta === 204, `attached=${rd.rows[0]?.attachedDelta}`);
// "Close the sheet".
for (const el of sheet2) el.isConnected = false;
sheet2 = null;
rd = P.listenerDelta();
ok("after close, only the persistent-target listeners remain attached",
  rd.rows[0].attachedDelta === 4, `attached=${rd.rows[0]?.attachedDelta}`);
ok("retained ratio identifies it as mostly released",
  rd.rows[0].retainedRatio < 0.05, `ratio=${rd.rows[0]?.retainedRatio}`);
ok("net attached delta is small", rd.totalAttachedDelta === 4, `net=${rd.totalAttachedDelta}`);
ok("the surviving target is named", rd.rows[0].attachedBy.length > 0,
  JSON.stringify(rd.rows[0].attachedBy));

section("AbortSignal removal is honoured");
P.listeners.clear();
const ac = new AbortController();
const abortTarget = globalThis.document;
abortTarget.addEventListener("keydown", () => {}, { signal: ac.signal });
P.sweepListeners();
const arec = P.listeners.get("keydown unattributed") || P.listeners.get("keydown core")
  || [...P.listeners.values()].find((r) => r.type === "keydown");
ok("signal-registered listener is tracked", arec && arec.attached === 1, `attached=${arec?.attached}`);
ac.abort();
P.sweepListeners();
ok("aborting the signal releases it", arec.attached === 0, `attached=${arec.attached}`);
ok("and it is recorded as aborted, not leaked", arec.aborted === 1, `aborted=${arec.aborted}`);

section("Sampling and self-measurement");
P.sample();
const s = P.samples.toArray();
ok("samples collected", s.length >= 2, `n=${s.length}`);
ok("heap sampled", s[s.length - 1].heap > 0);
ok("probe overhead tracked", P.overhead.stackCaptures > 0);

// Assert the per-capture cost, not a percentage. The percentage is meaningless in a synthetic
// run: this suite registers ~500 listeners with a fresh closure each in a fraction of a second,
// which is a far higher attribution rate than any real session, against a denominator of only a
// few seconds of wall clock. Per-capture cost is the invariant that actually generalises.
const nsPerCapture = (P.overhead.stackMs / P.overhead.stackCaptures) * 1e6;
ok("stack capture cost is bounded", nsPerCapture < 25000,
  `${nsPerCapture.toFixed(0)} ns/capture over ${P.overhead.stackCaptures} captures`);
// Attribution must be derived once per function, not once per registration.
const sharedFn = () => {};
const capturesBefore = P.overhead.stackCaptures;
alpha.registerNamed(sharedFn);
const afterFirst = P.overhead.stackCaptures;
for (let i = 0; i < 20; i++) alpha.registerNamed(sharedFn);
ok("first sight of a function costs one stack capture", afterFirst === capturesBefore + 1,
  `${afterFirst - capturesBefore}`);
ok("subsequent registrations of the same function are free",
  P.overhead.stackCaptures === afterFirst,
  `${P.overhead.stackCaptures - afterFirst} extra captures for 20 registrations`);

// And prove the self-throttle cannot fire on a short window — the bug that once disabled
// attribution for entire sessions.
P.overhead.stackMs = 1e6;   // absurd, deliberately
P.sample();
ok("overhead throttle ignores an unrepresentative window",
  P.overhead.degraded === false,
  `elapsed=${(performance.now() - P.p0).toFixed(0)}ms degraded=${P.overhead.degraded}`);
P.overhead.stackMs = 0;

section("Timeline");
// Drive the workload explicitly rather than relying on whatever earlier sections happened to
// cost: a warm JIT can bring the default `testHook` body under the 1.5 ms span threshold, which
// made this assertion flake.
for (let i = 0; i < 5 && !P.spans.toArray().some((x) => x.owner === "alpha-mod"); i++) {
  Hooks.callAll("testHook", 400000);
}
ok("slow callbacks recorded as spans", P.spans.toArray().some((x) => x.owner === "alpha-mod"),
  `spans=${P.spans.toArray().length}`);

/* =========================================================================================
   Foundry v14 regressions.

   Each of these encodes a defect that produced confident, wrong output rather than an error,
   which is the only failure mode that really matters in a diagnostic tool.
   ========================================================================================= */

section("Hooks.once is registered exactly once (v14)");
// Core's `Hooks.once` is `return this.on(hook, fn, {once: true})`. Because `this.on` is the
// patched one, a pre-wrapped callback comes straight back through the wrapper. Wrapping it a
// second time doubled every counter AND left `Hooks.events` holding a function that
// `originalToWrapped` could not resolve, so `Hooks.off` silently failed.
let onceRuns = 0;
const onceFn = () => { onceRuns++; };
alpha.registerOnce("v14Once", onceFn);
const onceRec = P.hooks.get("v14Once alpha-mod");
ok("once counted a single registration", onceRec?.regs === 1, `regs=${onceRec?.regs}`);
ok("once counted a single live registration", onceRec?.live === 1, `live=${onceRec?.live}`);
ok("only one entry landed in Hooks.events", (Hooks.events["v14Once"] || []).length === 1,
  `entries=${(Hooks.events["v14Once"] || []).length}`);
ok("the callback is not wrapped twice",
  Hooks.events["v14Once"][0].fn.__dmmOriginal?.__dmmWrapped !== true);

const onceOwnerCallsBefore = P.owners.get("alpha-mod").hookCalls;
Hooks.callAll("v14Once");
Hooks.callAll("v14Once");
ok("once fired exactly once", onceRuns === 1, `runs=${onceRuns}`);
ok("once counted exactly one call", onceRec.calls === 1, `calls=${onceRec.calls}`);
ok("once did not double-count owner hookCalls",
  P.owners.get("alpha-mod").hookCalls === onceOwnerCallsBefore + 1,
  `delta=${P.owners.get("alpha-mod").hookCalls - onceOwnerCallsBefore}`);
ok("a fired once-hook is released from the live count", onceRec.live === 0, `live=${onceRec.live}`);

section("Hooks.off works on a once-registered callback (v14)");
let ghostRuns = 0;
const ghostFn = () => { ghostRuns++; };
alpha.registerOnce("v14Ghost", ghostFn);
Hooks.off("v14Ghost", ghostFn);
Hooks.callAll("v14Ghost");
ok("off removed the entry", (Hooks.events["v14Ghost"] || []).length === 0,
  `remaining=${(Hooks.events["v14Ghost"] || []).length}`);
ok("the unregistered callback did not run", ghostRuns === 0, `runs=${ghostRuns}`);
ok("live count released on off", P.hooks.get("v14Ghost alpha-mod").live === 0);

section("Hooks.off by numeric id (v14)");
// v14's `Hooks.#call` auto-removes a once entry with `this.off(hook, id)`, and packages
// unregister by the id `Hooks.on` returned. Neither path decremented the live count, so
// hookRegsLive only ever climbed.
const byId = alpha.registerReturningId("v14ById", () => {});
const byIdRec = P.hooks.get("v14ById alpha-mod");
ok("registered by id", typeof byId === "number" && byIdRec.live === 1, `id=${byId}`);
Hooks.off("v14ById", byId);
ok("off by id removed the entry", (Hooks.events["v14ById"] || []).length === 0);
ok("off by id released the live count", byIdRec.live === 0, `live=${byIdRec.live}`);

section("Observers and idle callbacks (v14)");
const obsTarget = document.createElement("div");
let mutationRuns = 0;
const mo = alpha.observe("MutationObserver", obsTarget, () => {
  mutationRuns++;
  let x = 0; for (let i = 0; i < 200000; i++) x += Math.sqrt(i); return x;
});
const moRec = P.observers.get("MutationObserver alpha-mod");
ok("observer construction attributed to the module", !!moRec, `keys=${[...P.observers.keys()].join(" | ")}`);
ok("observer counted live", moRec?.live === 1, `live=${moRec?.live}`);
mo._fire([{}, {}]);
ok("observer callback ran", mutationRuns === 1, `runs=${mutationRuns}`);
ok("observer callback timed", moRec.calls === 1 && moRec.total > 0,
  `calls=${moRec.calls} total=${moRec.total}`);
ok("observer records counted", moRec.records === 2, `records=${moRec.records}`);
ok("observer time rolled up to the owner", P.owners.get("alpha-mod").observerTotal > 0);
ok("observer instance is still a real observer", typeof mo.takeRecords === "function");
mo.disconnect();
ok("disconnect releases the live count", moRec.live === 0, `live=${moRec.live}`);

P.mute("alpha-mod");
const mutedBefore = mutationRuns;
alpha.observe("ResizeObserver", obsTarget, () => { mutationRuns++; })._fire();
ok("muting silences observer callbacks", mutationRuns === mutedBefore);
P.unmute("alpha-mod");

let idleRan = 0;
alpha.scheduleIdle(() => { idleRan++; });
ok("idle callback registration attributed", P.owners.get("alpha-mod").idleRegs >= 1);
await new Promise((r) => setTimeout(r, 30));
ok("idle callback ran and was counted", idleRan === 1 && P.owners.get("alpha-mod").idleCalls === 1,
  `ran=${idleRan} counted=${P.owners.get("alpha-mod").idleCalls}`);

section("Detached windows are not phantom leaks (v14)");
// An application popped out into its own browser window is attached to *that* document. The
// probe must not treat its window as an eternally-live listener target.
const win = globalThis.__openDetachedWindow("popout-1");
alpha.listenTo(win, "resize", () => {});
P.sweepListeners();
const winRec = P.listeners.get("resize alpha-mod");
ok("listener on a detached window is tracked", winRec?.attached === 1, `attached=${winRec?.attached}`);
ok("detached window is labelled distinctly, not as 'window'",
  winRec.attachedBy.some(([l]) => l === "detached-window"),
  `labels=${JSON.stringify(winRec.attachedBy)}`);
win.close();
P.sweepListeners();
ok("closing the pop-out releases its listeners", winRec.attached === 0, `attached=${winRec.attached}`);
globalThis.foundry.applications.detached.windows.delete("popout-1");

section("Counter reset");
P.resetCounters();
ok("hooks cleared", P.hooks.size === 0);
ok("owner counters zeroed", P.owners.get("alpha-mod").hookCalls === 0);
ok("live interval registry survives reset (it tracks real handles)", P.liveIntervals instanceof Map);

/* -- analysis module ------------------------------------------------------------------------ */
section("Analysis module");
globalThis.game = {
  ready: true,
  modules: new Map([["alpha-mod", { id: "alpha-mod", title: "Alpha", active: true }]]),
  // The client only ever knows one system: the active one. It is not in `game.modules`.
  system: { id: "dnd5e", title: "D&D Fifth Edition", version: "5.0.0" },
  world: { id: "test-world", title: "Test World" },
  version: "14.365"
};
globalThis.game.modules.get = Map.prototype.get.bind(globalThis.game.modules);
const analysis = await import("../module/analysis.mjs");
const dnd5e = await import("./fixtures/systems/dnd5e/main.mjs");
alpha.registerBusyHook(200000);
dnd5e.register();
for (let i = 0; i < 5; i++) Hooks.callAll("scoreHook");
const rows = analysis.scorecard({});
ok("scorecard produces rows", rows.length > 0, `n=${rows.length}`);
ok("scorecard ranks by impact", rows.every((r, i) => i === 0 || rows[i - 1].score >= r.score));
const alphaRow = rows.find((r) => r.id === "alpha-mod");
ok("alpha appears with measured CPU", alphaRow && alphaRow.cpuMs > 0, `cpuMs=${alphaRow?.cpuMs}`);
const sysRow = rows.find((r) => r.id === "system:dnd5e");
ok("the active system appears as a package", !!sysRow, `ids=${rows.map((r) => r.id).join(" | ")}`);
ok("the active system is not reported as uninstalled", sysRow?.installed === true, `installed=${sysRow?.installed}`);
ok("the active system is reported as active", sysRow?.active === true, `active=${sysRow?.active}`);
ok("the active system uses its real title", sysRow?.title === "D&D Fifth Edition", `title=${sysRow?.title}`);
const coreRow = rows.find((r) => r.id === "core");
ok("Foundry core is not reported as uninstalled", !coreRow || coreRow.installed === true,
  `installed=${coreRow?.installed}`);
const f = analysis.findings({ rows });
ok("findings render without throwing", Array.isArray(f));
ok("heapTrend handles short series", analysis.heapTrend(P.samples.toArray()).valid === false);
const snapA = analysis.takeSnapshot("A", { samples: P.samples.toArray(), rows });
const snapB = analysis.takeSnapshot("B", { samples: P.samples.toArray(), rows });
const d = analysis.diffSnapshots(snapA, snapB);
ok("snapshot diff computes", d && typeof d.minutes === "number");

/* -- census pure functions ------------------------------------------------------------------- */
section("Census pure functions");
const census = await import("../module/census.mjs");
ok("bytes formats", census.bytes(1536) === "1.5 KB", census.bytes(1536));
ok("ms formats sub-ms", census.ms(0.25) === "0.25 ms", census.ms(0.25));
ok("ms formats seconds", census.ms(2500) === "2.50 s", census.ms(2500));
const cyc = { a: 1, s: "hello" }; cyc.self = cyc;
const est = census.estimateSize(cyc);
ok("estimateSize is cycle-safe", est.bytes > 0 && est.nodes < 100, JSON.stringify(est));
ok("estimateSize counts typed arrays exactly",
  census.estimateSize(new Uint8Array(1024)).bytes >= 1024);
const deep = { l: null }; let cur = deep;
for (let i = 0; i < 50; i++) { cur.l = { l: null }; cur = cur.l; }
ok("estimateSize respects depth cap", census.estimateSize(deep, { maxDepth: 5 }).truncated === true);
ok("jsonSize works", census.jsonSize({ a: "bb" }) === JSON.stringify({ a: "bb" }).length);

section("Package resolution");
// Flag namespaces and stack-derived owner ids are not all module ids: the active system, core
// and the world all write flags too, and none of them live in `game.modules`.
ok("an installed module resolves", census.resolvePackage("alpha-mod").installed === true);
ok("an installed module keeps its title", census.resolvePackage("alpha-mod").title === "Alpha");
ok("a genuinely absent module is still not installed",
  census.resolvePackage("ghost-mod").installed === false);
ok("the active system resolves by bare id (flag namespace)",
  census.resolvePackage("dnd5e").installed === true);
ok("the active system resolves by prefixed id (stack attribution)",
  census.resolvePackage("system:dnd5e").installed === true);
ok("the active system carries its title", census.resolvePackage("dnd5e").title === "D&D Fifth Edition");
ok("the active system is marked active", census.resolvePackage("system:dnd5e").active === true);
ok("some other world's system is still not installed",
  census.resolvePackage("system:pf2e").installed === false);
ok("core resolves", census.resolvePackage("core").installed === true);
ok("core is titled", census.resolvePackage("core").title === "Foundry Core");
ok("world flags resolve", census.resolvePackage("world").installed === true);
ok("world scripts resolve", census.resolvePackage("world-script").installed === true);
ok("unattributed is not claimed as installed",
  census.resolvePackage("unattributed").installed === false);
ok("unattributed is titled", census.resolvePackage("unattributed").title === "Unattributed");

/* -- summary ---------------------------------------------------------------------------------- */
console.log(`\n[1m${pass} passed, ${fail} failed[0m`);
if (fail) {
  console.log("Failures:\n" + failures.map((f2) => `  - ${f2}`).join("\n"));
  process.exit(1);
}
process.exit(0);
