/**
 * Overhead benchmark.
 *   node test/bench.mjs
 *
 * Measures what the instrumentation actually costs per instrumented call, so the README can
 * quote a real number instead of an assurance. Run it on the machine you care about.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { installHarness } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const N = 200000;

function timeIt(label, fn, iterations) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const dt = performance.now() - t0;
  return { label, totalMs: dt, perCallNs: (dt / iterations) * 1e6 };
}

/* ---- baseline: uninstrumented ---------------------------------------------------------- */
installHarness();
const bareHooks = globalThis.Hooks;
let sink = 0;
const trivial = () => { sink++; };
bareHooks.on("bench", trivial);
const baseline = timeIt("uninstrumented Hooks.callAll", () => bareHooks.callAll("bench"), N);

const busy = () => { let x = 0; for (let i = 0; i < 200; i++) x += Math.sqrt(i); sink += x; };
bareHooks.events = {}; bareHooks.on("busy", busy);
const baselineBusy = timeIt("uninstrumented Hooks.callAll (realistic callback)", () => bareHooks.callAll("busy"), N / 10);

const bareNode = new globalThis.Node("div");
const child = new globalThis.Node("span");
const baselineDom = timeIt("uninstrumented appendChild", () => { bareNode.appendChild(child); bareNode.removeChild(child); }, N);

/* ---- instrumented ------------------------------------------------------------------------- */
vm.runInThisContext(readFileSync(join(root, "scripts", "dmm-probe.js"), "utf8"),
  { filename: "http://localhost:30000/modules/dmm-performance-checker/scripts/dmm-probe.js" });

globalThis.Hooks.events = {};
globalThis.Hooks.on("bench", trivial);
const instrumented = timeIt("instrumented Hooks.callAll", () => globalThis.Hooks.callAll("bench"), N);

globalThis.Hooks.events = {};
globalThis.Hooks.on("busy", busy);
const instrumentedBusy = timeIt("instrumented Hooks.callAll (realistic callback)", () => globalThis.Hooks.callAll("busy"), N / 10);

const instrumentedDom = timeIt("instrumented appendChild", () => { bareNode.appendChild(child); bareNode.removeChild(child); }, N);

/* ---- report --------------------------------------------------------------------------------- */
const rows = [
  { case: "Hook dispatch, trivial callback", base: baseline.perCallNs, inst: instrumented.perCallNs },
  { case: "Hook dispatch, ~2µs callback", base: baselineBusy.perCallNs, inst: instrumentedBusy.perCallNs },
  { case: "DOM append+remove pair", base: baselineDom.perCallNs, inst: instrumentedDom.perCallNs }
];

console.log(`\nProbe overhead benchmark (${N.toLocaleString()} iterations, node ${process.version})\n`);
console.table(rows.map((r) => ({
  case: r.case,
  "baseline ns/call": r.base.toFixed(0),
  "instrumented ns/call": r.inst.toFixed(0),
  "added ns/call": (r.inst - r.base).toFixed(0),
  "relative": `${(((r.inst - r.base) / r.base) * 100).toFixed(0)}%`
})));

const perHook = rows[1].inst - rows[1].base;
console.log(`\nInterpretation: a realistic hook callback costs ~${rows[1].base.toFixed(0)} ns uninstrumented.`);
console.log(`Instrumentation adds ~${perHook.toFixed(0)} ns to each one.`);
console.log(`At a heavy 50,000 instrumented callbacks per second that is ${((perHook * 50000) / 1e6).toFixed(1)} ms/s ` +
  `= ${((perHook * 50000) / 1e7).toFixed(2)}% of one core.\n`);
console.log("The trivial-callback row is the pessimistic bound: it measures pure wrapper cost against a");
console.log("callback that does nothing, which no real module does. Judge by the realistic row.\n");

process.exit(0);
