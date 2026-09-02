/**
 * DMM Performance Checker — Analysis
 * ----------------------------------
 * Turns raw counters into a ranked scorecard and a list of concrete, falsifiable findings.
 *
 * Design principle: every finding states the measurement it is based on and what would
 * disprove it. A profiler that just says "this module is slow" is a rumour generator.
 */

import { bytes, ms, resolvePackage } from "./census.mjs";

const P = () => globalThis.DMMPC;

export const SEV = { CRITICAL: 3, WARN: 2, INFO: 1 };
const SEV_NAME = { 3: "critical", 2: "warning", 1: "info" };

/* ---------------------------------------------------------------------------------------- */
/* Scorecard                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/**
 * Build the per-module table. `elapsedMs` is wall time since the counters were last reset,
 * which is what turns totals into rates — the only comparable unit across a long session.
 */
export function scorecard({ resources = [], canvas = null, memory = null } = {}) {
  const p = P();
  if (!p) return [];
  const elapsed = Math.max(1, performance.now() - p.p0);
  const mins = elapsed / 60000;

  const resById = new Map(resources.map((r) => [r.owner, r]));
  const memById = new Map((memory?.modules || []).map((m) => [m.id, m]));
  const canvasById = new Map((canvas?.byOwner || []).map((c) => [c.owner, c.n]));

  const rows = [];
  for (const o of p.owners.values()) {
    // Owner ids come from stack attribution, so they include `system:<id>`, `world-script`,
    // `core` and `unattributed` as well as module ids. Resolve them all, not just modules.
    const pkg = resolvePackage(o.id);
    // Charge each package its *exclusive* libWrapper cost. The inclusive figure is kept
    // separately: a pass-through wrapper on a hot core function envelopes enormous amounts of
    // time that belongs to core and to other packages, and billing it here would make the
    // wrapper's owner look like the worst offender in the world.
    const observerMs = (o.observerTotal || 0) + (o.idleTotal || 0);
    const observerSelfMs = (o.observerSelf || 0) + (o.idleTotal || 0);
    const cpuMs = o.hookTotal + o.timerTotal + o.listenerTotal + o.tickerTotal + o.rafTotal
      + (o.lwSelf || 0) + observerMs;
    const selfMs = o.hookSelf + o.timerSelf + o.listenerSelf + o.tickerTotal + (o.lwSelf || 0)
      + observerSelfMs;
    const lwInclusive = o.lwInclusive || 0;
    const res = resById.get(o.id);
    const mem = memById.get(o.id);

    const row = {
      id: o.id,
      title: pkg.title,
      kind: pkg.kind,
      installed: pkg.installed,
      active: pkg.active,
      muted: p.muted.has(o.id),

      cpuMs,
      selfMs,
      cpuPct: (cpuMs / elapsed) * 100,
      msPerMin: cpuMs / Math.max(0.01, mins),

      hookCalls: o.hookCalls,
      hookTotal: o.hookTotal,
      hookMax: o.hookMax,
      hookMaxName: o.hookMaxName,
      hookRegsLive: o.hookRegsLive,

      lwCalls: o.lwCalls || 0,
      lwSelf: o.lwSelf || 0,
      lwInclusive,
      lwMax: o.lwMax || 0,
      lwMaxTarget: o.lwMaxTarget || "",
      // How much of what this package's wrappers enveloped was actually somebody else's work.
      lwPassThrough: Math.max(0, lwInclusive - (o.lwSelf || 0)),

      // Where this package's charged CPU actually comes from — the answer to "why is this
      // module at the top of the list?"
      costMix: {
        hooks: o.hookSelf,
        libWrapper: o.lwSelf || 0,
        ticker: o.tickerTotal,
        listeners: o.listenerSelf,
        timers: o.timerSelf + o.rafTotal,
        observers: observerSelfMs
      },

      observerCalls: o.observerCalls || 0,
      observerTotal: o.observerTotal || 0,
      observerMax: o.observerMax || 0,
      observerRegs: o.observerRegs || 0,
      idleCalls: o.idleCalls || 0,
      idleTotal: o.idleTotal || 0,

      tickerTotal: o.tickerTotal,
      tickerCalls: o.tickerCalls,
      tickerRegs: o.tickerRegs,
      msPerFrame: p.global.frames ? o.tickerTotal / p.global.frames : 0,
      // Share of *this display's* frame budget, not of an assumed 60 Hz one.
      pctOfFrame: p.global.frames ? ((o.tickerTotal / p.global.frames) / (p.frameBudgetMs || 16.67)) * 100 : 0,

      listenerCalls: o.listenerCalls,
      listenerTotal: o.listenerTotal,
      listenerRegs: o.listenerRegs,

      timerCalls: o.timerCalls,
      timerTotal: o.timerTotal,
      intervalRegs: o.intervalRegs,
      liveIntervals: countLive(p.liveIntervals, o.id),

      domOps: o.domOps,
      domOpsPerMin: o.domOps / Math.max(0.01, mins),
      domHtmlChars: o.domHtmlChars,

      storageWrites: o.storageWrites,
      storageBytes: o.storageBytes,

      netRequests: o.netRequests,
      netBytes: o.netBytes,
      netTotal: o.netTotal,

      dbDocs: o.dbDocs,
      dbBytes: o.dbBytes,

      errors: o.errors,
      longTaskMs: o.longTaskMs,

      assetBytes: res?.decoded || 0,
      assetMs: res?.duration || 0,
      assetCount: res?.count || 0,
      biggestAsset: res?.biggest || null,

      retainedBytes: mem?.bytes || 0,
      retainedTruncated: !!mem?.truncated,

      canvasObjects: canvasById.get(o.id) || 0
    };
    row.score = impactScore(row, elapsed);
    rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

function countLive(map, ownerId) {
  let n = 0;
  for (const v of map.values()) if (v.owner === ownerId) n++;
  return n;
}

/**
 * Composite impact score, 0-100+. Weighted toward things you actually feel:
 * per-frame cost and long tasks hurt far more than a one-off 200ms at startup.
 */
function impactScore(r, elapsedMs) {
  let s = 0;
  s += Math.min(45, r.cpuPct * 9);                        // sustained main-thread share
  s += Math.min(25, (r.pctOfFrame || 0) * 4);             // per-frame ticker cost, budget-relative
  s += Math.min(15, (r.longTaskMs / Math.max(1, elapsedMs)) * 1500);
  s += Math.min(8, r.domOpsPerMin / 2000);                // DOM churn
  s += Math.min(6, r.liveIntervals * 1.5);                // background timers
  s += Math.min(5, r.errors / 4);                         // error storms
  s += Math.min(5, r.storageWrites / 400);                // synchronous storage writes
  s += Math.min(4, r.assetBytes / (4 * 1024 * 1024));     // download/parse weight
  s += Math.min(4, r.retainedBytes / (64 * 1024 * 1024)); // retained heap proxy
  s += Math.min(3, r.netRequests / 250);
  return Math.round(s * 10) / 10;
}

/* ---------------------------------------------------------------------------------------- */
/* Trend maths                                                                                */
/* ---------------------------------------------------------------------------------------- */

/** Least-squares slope of y over x. */
function slope(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

/**
 * Heap growth is noisy because GC saws it up and down. The signal that matters is whether the
 * *floor* is rising — the post-collection baseline. We take the minimum of each bucket and
 * regress on that.
 */
export function heapTrend(samples, buckets = 12) {
  const pts = samples.filter((s) => s && s.heap > 0);
  if (pts.length < buckets) return { valid: false };
  const per = Math.floor(pts.length / buckets);
  const xs = [], ys = [];
  for (let b = 0; b < buckets; b++) {
    const slice = pts.slice(b * per, (b + 1) * per);
    if (!slice.length) continue;
    let min = Infinity, tSum = 0;
    for (const s of slice) { if (s.heap < min) min = s.heap; tSum += s.t; }
    xs.push(tSum / slice.length);
    ys.push(min);
  }
  const m = slope(xs, ys);                       // bytes per ms
  const perHour = m * 3600 * 1000;
  const spanMs = xs[xs.length - 1] - xs[0];
  return {
    valid: xs.length >= 4 && spanMs > 60000,
    bytesPerHour: perHour,
    floorStart: ys[0],
    floorEnd: ys[ys.length - 1],
    spanMinutes: spanMs / 60000,
    points: xs.map((x, i) => ({ t: x, v: ys[i] })),
    limit: pts[pts.length - 1]?.heapLimit || 0
  };
}

/** Compare the first third of the session to the last third for any numeric sample field. */
export function drift(samples, field) {
  const pts = samples.filter((s) => s && isFinite(s[field]));
  if (pts.length < 9) return null;
  const third = Math.floor(pts.length / 3);
  const avg = (arr) => arr.reduce((a, b) => a + b[field], 0) / arr.length;
  const early = avg(pts.slice(0, third));
  const late = avg(pts.slice(-third));
  return { early, late, delta: late - early, pct: early ? ((late - early) / early) * 100 : 0 };
}

/* ---------------------------------------------------------------------------------------- */
/* Findings                                                                                   */
/* ---------------------------------------------------------------------------------------- */

/**
 * @returns {Array<{sev:number, sevName:string, owner:string, title:string, detail:string,
 *                  action:string, metric:string}>}
 */
export function findings(ctx) {
  const { rows = [], canvas = null, dom = null, data = null, memory = null } = ctx;
  const p = P();
  const out = [];
  if (!p) return out;

  const elapsed = performance.now() - p.p0;
  const mins = elapsed / 60000;
  const samples = p.samples.toArray();

  // `src` tags each finding with the evidence family it came from, so the detail modal knows
  // which supporting table to freeze alongside it. Set once per section below.
  let src = "meta";
  let seq = 0;
  const add = (sev, owner, title, detail, action, metric) =>
    out.push({ id: `f${seq++}`, sev, sevName: SEV_NAME[sev], owner, title, detail, action, metric, source: src });

  /* -- meta: is the data trustworthy? ----------------------------------------------------- */
  if (p.preExisting > 0) {
    add(SEV.INFO, "dmm-performance-checker", "Probe loaded after some hooks were registered",
      `${p.preExisting} hook callbacks were already registered before instrumentation attached. Their execution is still timed only if they were registered through a patched path; otherwise they land in "unattributed".`,
      "Only matters if 'unattributed' is a large share below. Modules whose classic scripts sort before this one (alphabetically by package id) can register first.",
      `${p.preExisting} pre-existing callbacks`);
  }
  const unattr = rows.find((r) => r.id === "unattributed");
  const totalCpu = rows.reduce((a, b) => a + b.cpuMs, 0);
  if (unattr && totalCpu > 0 && unattr.cpuMs / totalCpu > 0.25) {
    add(SEV.WARN, "unattributed", "Large share of time is unattributed",
      `${((unattr.cpuMs / totalCpu) * 100).toFixed(0)}% of measured callback time could not be traced to a package.`,
      "Usually means stack sampling degraded under load, or a module obfuscates its stack (bundled/minified with no source path). Check probe overhead on the Overview tab.",
      `${ms(unattr.cpuMs)} unattributed`);
  }
  const cap = p.capabilities || {};
  const missing = [];
  if (cap.heap === false) missing.push("heap size and leak detection (performance.memory)");
  if (cap.longTask === false) missing.push("long-task detection — the Timeline tab's freeze list will stay empty");
  if (cap.eventTiming === false) missing.push("input latency measurement");
  if (missing.length) {
    add(SEV.INFO, "", `Some measurements are unavailable in ${cap.engine === "firefox" ? "Firefox" : "this browser"}`,
      `Unavailable here: ${missing.join("; ")}. These are Chromium-only APIs. Absent data shows as empty or zero, ` +
      `which is not the same as "no problem" — do not read a blank Memory tab as a clean bill of health.`,
      cap.engine === "firefox"
        ? "Everything else — per-module CPU, hooks, frames, timers, DOM churn, canvas, world data, network — works fully in Firefox. " +
          "For the memory and freeze questions specifically, run one diagnostic session in the Foundry desktop client or Chrome. " +
          "The Memory tab's growth indicators (listeners, DOM nodes, chat DOM, live intervals) do not need performance.memory and still work here."
        : "Use a Chromium-based client for the full picture.",
      `${missing.length} unavailable`);
  }
  if (cap.secureContext === false) {
    add(SEV.INFO, "", "Page is not a secure context",
      `You are reaching Foundry over plain http on a non-localhost origin, so the browser disables the async clipboard API ` +
      `(and a few others). Copy buttons fall back to a manual copy box.`,
      "Harmless for diagnosis. Only worth changing if the clipboard fallback annoys you.",
      "http origin");
  }

  if (p.overhead.degraded) {
    add(SEV.INFO, "dmm-performance-checker", "Attribution sampling degraded",
      `The probe exceeded its own overhead budget (${p.cfg.overheadBudgetPct}%) and dropped to 1-in-16 stack sampling. ${p.overhead.skipped} captures skipped.`,
      "Counts and timings remain exact; only the ownership of newly-seen callbacks is sampled. Raise the budget in settings if you want full attribution during a stress test.",
      `${p.overhead.stackCaptures} captures`);
  }

  src = "module";
  /* -- CPU / frame cost ------------------------------------------------------------------- */
  for (const r of rows) {
    if (r.id === "core" || r.id === "unattributed") continue;

    // Describe where the cost came from, rather than asserting a hottest hook that may not exist.
    const mix = Object.entries(r.costMix || {}).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);
    const mixText = mix.length
      ? `Breakdown: ${mix.map(([k, v]) => `${k} ${ms(v)}`).join(", ")}.`
      : "";
    const worstText = r.hookCalls
      ? ` Hottest hook: ${r.hookMaxName || "unnamed"} (worst single call ${ms(r.hookMax)}).`
      : r.lwCalls
        ? ` Hottest wrapper: ${r.lwMaxTarget || "unnamed"} (worst single call ${ms(r.lwMax)} of its own code).`
        : "";

    if (r.cpuPct >= 8) {
      add(SEV.CRITICAL, r.id, "Sustained main-thread consumption",
        `${r.title} used ${ms(r.cpuMs)} of main-thread time over ${mins.toFixed(1)} minutes — ${r.cpuPct.toFixed(1)}% of wall clock. ${mixText}${worstText}`,
        `Mute it from the Modules tab and watch FPS for 30 seconds. If FPS recovers, this is your problem. If not, the cost is real but not what you're feeling.`,
        `${r.cpuPct.toFixed(1)}% CPU`);
    } else if (r.cpuPct >= 3) {
      add(SEV.WARN, r.id, "Noticeable main-thread consumption",
        `${r.title} used ${r.cpuPct.toFixed(1)}% of wall-clock time (${ms(r.cpuMs)} over ${mins.toFixed(1)} min). ${mixText}`,
        "Acceptable in isolation. Worth muting if you have several modules in this band — they add up.",
        `${r.cpuPct.toFixed(1)}% CPU`);
    }

    // Pass-through wrappers: worth surfacing so the number is never mysterious, but explicitly
    // *not* charged to the package. libWrapper itself does this to Application.prototype._render.
    if (r.lwPassThrough > 5000 && r.lwPassThrough > r.lwSelf * 20) {
      add(SEV.INFO, r.id, "Wraps a hot function but adds almost nothing",
        `${r.title} has libWrapper wrappers that enveloped ${ms(r.lwInclusive)} of execution, but only ${ms(r.lwSelf)} of that was its own code — ` +
        `${((r.lwPassThrough / Math.max(1, r.lwInclusive)) * 100).toFixed(1)}% was the downstream function it wraps. ` +
        `Busiest target: ${r.lwMaxTarget || "n/a"}.`,
        `This package is charged only its own ${ms(r.lwSelf)}, which is the honest figure. The large envelope tells you the *wrapped function* is hot — ` +
        `look at what is calling it, not at this package. ` +
        (r.id === "lib-wrapper"
          ? "libWrapper registers a pass-through wrapper on Application.prototype._render purely to catch render errors, so its envelope is the total cost of every application render in the session."
          : ""),
        `${ms(r.lwSelf)} own / ${ms(r.lwInclusive)} enveloped`);
    }

    const budget = p.frameBudgetMs || 16.67;
    const hzNote = `${p.refreshHz} Hz display, ${budget.toFixed(1)} ms per frame${p.refreshDetected ? "" : " (assumed — not yet measured)"}`;
    if (r.pctOfFrame >= 8) {
      add(SEV.CRITICAL, r.id, "Expensive per-frame work",
        `${r.title} runs PIXI ticker callbacks costing ${r.msPerFrame.toFixed(2)} ms every frame — ${r.pctOfFrame.toFixed(0)}% of your frame budget (${hzNote}).`,
        "This is a direct, permanent FPS tax. Mute it and re-measure — the FPS delta should be roughly proportional.",
        `${r.pctOfFrame.toFixed(0)}% of frame`);
    } else if (r.pctOfFrame >= 2.5) {
      add(SEV.WARN, r.id, "Per-frame work",
        `${r.title} costs ${r.msPerFrame.toFixed(2)} ms/frame (${r.pctOfFrame.toFixed(1)}% of the budget) across ${r.tickerRegs} ticker registration(s). ${hzNote}.`,
        "Fine alone; check whether several modules are each taking a slice of every frame. Sort the Frames tab by ms/frame and add up the top rows.",
        `${r.pctOfFrame.toFixed(1)}% of frame`);
    }

    if (r.longTaskMs > 500) {
      add(SEV.WARN, r.id, "Contributes to main-thread stalls",
        `${ms(r.longTaskMs)} of this module's work landed inside browser long tasks (>50 ms blocks), which is what you feel as a freeze or dropped input.`,
        "Cross-reference the Timeline tab to see when these happen — usually a specific action (opening a sheet, switching scenes, a chat card).",
        `${ms(r.longTaskMs)} in long tasks`);
    }

    /* -- background churn ----------------------------------------------------------------- */
    if (r.liveIntervals >= 3) {
      const detail = [...p.liveIntervals.values()].filter((v) => v.owner === r.id);
      const fastest = Math.min(...detail.map((d) => d.delay || Infinity));
      add(fastest <= 250 ? SEV.CRITICAL : SEV.WARN, r.id, "Background timers running continuously",
        `${r.liveIntervals} live setInterval handles. Fastest fires every ${isFinite(fastest) ? fastest : "?"} ms. Total interval callback time: ${ms(r.timerTotal)}.`,
        "Intervals never stop, even when nothing is happening. Run the Idle Churn test to see exactly what they cost when your table is doing nothing.",
        `${r.liveIntervals} intervals`);
    }

    if (r.storageWrites / Math.max(0.01, mins) > 60) {
      add(SEV.CRITICAL, r.id, "Frequent synchronous storage writes",
        `${r.storageWrites} localStorage writes (${bytes(r.storageBytes)}) — ${(r.storageWrites / mins).toFixed(0)}/min. localStorage is synchronous and disk-backed; each write blocks the main thread.`,
        "This is a common cause of periodic micro-stutter. Usually a module persisting a client setting on every change instead of debouncing.",
        `${(r.storageWrites / mins).toFixed(0)} writes/min`);
    }

    if (r.domOpsPerMin > 20000) {
      add(SEV.WARN, r.id, "High DOM churn",
        `${Math.round(r.domOpsPerMin).toLocaleString()} DOM mutations per minute` +
        (r.domHtmlChars > 1e6 ? `, plus ${bytes(r.domHtmlChars * 2)} of innerHTML assignments` : "") + ".",
        "DOM writes force style recalculation and layout. Heavy churn shows up as sluggish UI even when FPS looks fine.",
        `${Math.round(r.domOpsPerMin).toLocaleString()} ops/min`);
    }

    if (r.netRequests / Math.max(0.01, mins) > 30) {
      add(SEV.WARN, r.id, "Frequent network requests",
        `${r.netRequests} requests in ${mins.toFixed(1)} min (${(r.netRequests / mins).toFixed(0)}/min), ${bytes(r.netBytes)} transferred.`,
        "Check the Network tab for the repeated path. Polling modules and file-scanning modules do this.",
        `${(r.netRequests / mins).toFixed(0)} req/min`);
    }

    if (r.dbDocs / Math.max(0.01, mins) > 60) {
      add(SEV.CRITICAL, r.id, "Database write storm",
        `${r.dbDocs} document writes in ${mins.toFixed(1)} min (${bytes(r.dbBytes)}). Every write is broadcast to all connected clients.`,
        "This degrades everyone's session, not just yours. Common culprits: modules syncing state via flags on every token move or combat turn.",
        `${(r.dbDocs / mins).toFixed(0)} writes/min`);
    }

    if (r.errors >= 20) {
      add(SEV.CRITICAL, r.id, "Repeated exceptions",
        `${r.errors} exceptions thrown from this module's callbacks. Thrown errors are expensive (stack construction) and usually mean a hook runs and fails on every single event.`,
        "See the Errors tab for the signature. A module erroring in refreshToken can cost more than one doing real work.",
        `${r.errors} errors`);
    } else if (r.errors >= 5) {
      add(SEV.WARN, r.id, "Exceptions thrown", `${r.errors} exceptions from this module.`, "Check the Errors tab.", `${r.errors} errors`);
    }

    if (r.assetBytes > 8 * 1024 * 1024) {
      add(SEV.WARN, r.id, "Very large script/asset payload",
        `${bytes(r.assetBytes)} decoded across ${r.assetCount} files, ${ms(r.assetMs)} of network time.` +
        (r.biggestAsset ? ` Largest: ${r.biggestAsset.name} (${bytes(r.biggestAsset.bytes)}).` : ""),
        "This is a world-load and memory cost, not a frame-rate cost. It inflates baseline heap for the whole session.",
        bytes(r.assetBytes));
    }

    if (r.retainedBytes > 96 * 1024 * 1024) {
      add(SEV.WARN, r.id, "Large retained data structure",
        `Estimated ${bytes(r.retainedBytes)} held on this module's public API/instance objects${r.retainedTruncated ? " (walk was truncated — the real figure is higher)" : ""}.`,
        "Typical of search indexes and compendium caches. Look for a setting to limit what it indexes, or to build the index lazily.",
        bytes(r.retainedBytes));
    }
  }

  src = "memory";
  /* -- memory ------------------------------------------------------------------------------ */
  // `performance.memory` is a non-standard Chromium API. Without it there is no heap signal at
  // all, and silently showing "0 B" would be worse than saying so.
  if (p.heapAvailable === false) {
    add(SEV.INFO, "", "Heap measurement unavailable in this client",
      "performance.memory is not exposed, so heap size, the post-GC floor trend and leak detection are all unavailable. " +
      "It is a Chromium-only API — present in the Foundry desktop client and in Chrome/Edge, absent in Firefox and Safari.",
      "Everything else on this dashboard still works. For memory specifically, use the Foundry desktop client or a Chromium browser, " +
      "or fall back to the growth indicators on the Memory tab (listeners, DOM nodes, canvas objects), which do not depend on it.",
      "no heap API");
  }
  const trend = p.heapAvailable === false ? { valid: false } : heapTrend(samples);
  if (trend.valid) {
    const perHour = trend.bytesPerHour;
    if (perHour > 250 * 1024 * 1024) {
      add(SEV.CRITICAL, "", "Heap floor is climbing fast",
        `The post-GC heap floor rose from ${bytes(trend.floorStart)} to ${bytes(trend.floorEnd)} over ${trend.spanMinutes.toFixed(0)} minutes — a trend of ${bytes(perHour)}/hour. This is a leak, not normal churn.` +
        (trend.limit ? ` Tab limit is ${bytes(trend.limit)}; at this rate you have roughly ${((trend.limit - trend.floorEnd) / perHour).toFixed(1)} hours before the tab dies.` : ""),
        "Take a snapshot now, play for 30 more minutes, take another, and diff them on the Snapshots tab. The counter that grows without bound (live listeners, canvas objects, chat DOM, live intervals) names the leak.",
        `${bytes(perHour)}/hour`);
    } else if (perHour > 80 * 1024 * 1024) {
      add(SEV.WARN, "", "Heap floor is climbing",
        `Post-GC floor trending up ${bytes(perHour)}/hour over ${trend.spanMinutes.toFixed(0)} minutes.`,
        "Worth watching across a full session. Compare snapshots from the start and end of a game night.",
        `${bytes(perHour)}/hour`);
    }
  }
  const heapNow = memory?.heap;
  if (heapNow && heapNow.pctOfLimit > 80) {
    add(SEV.CRITICAL, "", "Heap near the tab limit",
      `${bytes(heapNow.used)} of ${bytes(heapNow.limit)} (${heapNow.pctOfLimit.toFixed(0)}%). Chrome/Electron will start GC-thrashing well before the hard limit, which presents as periodic multi-second freezes.`,
      "Reload between sessions is a workaround, not a fix. Find the retainer above.",
      `${heapNow.pctOfLimit.toFixed(0)}% of limit`);
  }

  src = "growth";
  /* -- listener + handle leaks -------------------------------------------------------------- */
  // Listener accounting, carefully.
  //
  // "Added minus explicitly removed" is a useless leak signal in Foundry: applications discard
  // their entire element on close without ever calling removeEventListener, so opening and
  // closing one character sheet can add thousands to that number permanently while retaining
  // nothing at all. The signal that means something is registrations whose target is *still
  // connected to the document*, which the probe tracks with WeakRefs.
  const attachedDrift = drift(samples, "listenersAttached");
  const rawDrift = drift(samples, "listeners");
  if (attachedDrift && attachedDrift.delta > 400 && attachedDrift.pct > 35) {
    const worst = [...p.listeners.values()].sort((a, b) => b.attached - a.attached).slice(0, 3)
      .map((l) => `${l.owner}:${l.type} (${l.attached} attached)`).join(", ");
    add(SEV.CRITICAL, "", "Event listeners accumulating on live elements",
      `Listeners whose target is still in the document grew from ${Math.round(attachedDrift.early)} to ${Math.round(attachedDrift.late)} (+${attachedDrift.pct.toFixed(0)}%). ` +
      `These are not being cleaned up by element destruction, so each one keeps its whole closure alive.`,
      `Biggest holders: ${worst}. This is the most common cause of "it gets slower every hour". ` +
      `Check whether they are attached to window/document rather than to the application's own element — those are the ones that survive a close.`,
      `+${Math.round(attachedDrift.delta)} attached`);
  } else if (rawDrift && rawDrift.delta > 2000 && attachedDrift && attachedDrift.pct < 15) {
    // Explicitly reassure, because the raw number looks alarming and people will see it.
    add(SEV.INFO, "", "Listener registrations climbing, but nothing is being retained",
      `Total registrations grew by ${Math.round(rawDrift.delta).toLocaleString()}, but the count still attached to the document only moved ${attachedDrift.pct.toFixed(0)}%. ` +
      `Foundry applications throw their element away on close without calling removeEventListener, so the raw counter rises every time you open a sheet and never falls. ` +
      `The elements and their listeners are collected normally.`,
      `Not a leak. Judge by the "Attached" column on the DOM tab, not by "Not removed".`,
      `${Math.round(rawDrift.delta).toLocaleString()} registrations, no retention`);
  }
  const nodeDrift = drift(samples, "domNodes");
  if (nodeDrift && nodeDrift.delta > 5000 && nodeDrift.pct > 30) {
    add(SEV.WARN, "", "DOM node count growing",
      `Document grew from ${Math.round(nodeDrift.early).toLocaleString()} to ${Math.round(nodeDrift.late).toLocaleString()} elements.`,
      "Check the DOM tab for which region is growing. Chat log is the usual answer.",
      `+${Math.round(nodeDrift.delta).toLocaleString()} nodes`);
  }

  src = "dom";
  /* -- DOM / chat -------------------------------------------------------------------------- */
  if (dom) {
    if (dom.chat.domMessages > 400) {
      add(dom.chat.domMessages > 1000 ? SEV.CRITICAL : SEV.WARN, "", "Chat log is very large",
        `${dom.chat.domMessages} messages rendered in the DOM, ${dom.chat.nodes.toLocaleString()} elements (${dom.chat.nodesPerMessage} per message). Every module that hooks renderChatMessage pays this cost again on each re-render.`,
        `Core keeps a rolling buffer (Chat Log > messages shown). ${dom.chat.nodesPerMessage > 60 ? `At ${dom.chat.nodesPerMessage} nodes per message, a module is adding substantial markup to each card — see the DOM tab.` : "Reducing the buffer is the cheapest win available in a long session."}`,
        `${dom.chat.domMessages} messages`);
    }
    // Deliberately `orphaned`, not "detached": from v14 an application can legitimately be
    // popped out into its own browser window, and those are neither leaked nor a finding.
    const orphaned = dom.apps.list.filter((a) => a.orphaned);
    if (orphaned.length) {
      add(SEV.WARN, "", "Applications rendered but orphaned from every document",
        `${orphaned.length} application instance(s) hold DOM that is in no document at all: ${orphaned.slice(0, 4).map((d) => d.cls).join(", ")}.`,
        "Orphaned DOM held by a live JS reference is a textbook leak. Usually an app that was re-rendered without closing the old element. Applications popped out into a v14 detached window are excluded from this count — they are attached to their own document.",
        `${orphaned.length} orphaned`);
    }
    if (dom.total > 60000) {
      add(SEV.WARN, "", "Very large DOM",
        `${dom.total.toLocaleString()} elements in the document. Style recalculation and layout scale with this.`,
        `Heaviest region: ${dom.byRegion[0] ? `${dom.byRegion[0].sel} (${dom.byRegion[0].nodes.toLocaleString()})` : "n/a"}.`,
        `${dom.total.toLocaleString()} nodes`);
    }
    if (dom.cssRules > 30000) {
      add(SEV.INFO, "", "Large CSS rule count",
        `${dom.cssRules.toLocaleString()} CSS rules across ${dom.styleSheets} stylesheets. Selector matching cost is paid on every style recalculation.`,
        "Mostly a symptom of many modules rather than one. Only actionable if a single module ships an enormous stylesheet.",
        `${dom.cssRules.toLocaleString()} rules`);
    }
  }

  src = "canvas";
  /* -- canvas ------------------------------------------------------------------------------ */
  if (canvas?.available) {
    if (canvas.textures.bytes > 1.5 * 1024 * 1024 * 1024) {
      add(SEV.CRITICAL, "", "Very high GPU texture memory",
        `${bytes(canvas.textures.bytes)} across ${canvas.textures.count} base textures. Largest: ${canvas.textures.biggest.slice(0, 3).map((t) => `${t.key} ${t.w}×${t.h}`).join(", ")}.`,
        "Oversized scene backgrounds and un-downscaled token/tile art. This is the single biggest cause of canvas stutter and GPU-side memory pressure.",
        bytes(canvas.textures.bytes));
    } else if (canvas.textures.bytes > 700 * 1024 * 1024) {
      add(SEV.WARN, "", "High GPU texture memory",
        `${bytes(canvas.textures.bytes)} across ${canvas.textures.count} base textures.`,
        "Check the Canvas tab for the biggest offenders and consider downscaling those source images.",
        bytes(canvas.textures.bytes));
    }
    if (canvas.filteredObjects > 60) {
      add(SEV.WARN, "", "Many filtered display objects",
        `${canvas.filteredObjects} canvas objects carry ${canvas.filterCount} filters. Top filter: ${canvas.filters[0] ? `${canvas.filters[0].name} ×${canvas.filters[0].count}` : "?"}.`,
        "Each filtered object forces an extra render target and a full-screen-ish pass. Per-token filters are the classic FPS killer — check which module applies them.",
        `${canvas.filterCount} filters`);
    }
    if (canvas.totalObjects > 25000) {
      add(SEV.WARN, "", "Very large canvas scene graph",
        `${canvas.totalObjects.toLocaleString()} display objects, max depth ${canvas.maxDepth}.` +
        (canvas.byOwner.length ? ` Attributed: ${canvas.byOwner.slice(0, 3).map((o) => `${o.owner} ${o.n}`).join(", ")}.` : " Enable the deep canvas probe in settings to attribute these to modules."),
        "Every object is traversed each frame even when it renders nothing. Walls and lights on huge scenes dominate; modules that add per-token overlays add up fast.",
        `${canvas.totalObjects.toLocaleString()} objects`);
    }
    if (canvas.tickerListeners > 60) {
      add(SEV.WARN, "", "Many PIXI ticker listeners",
        `${canvas.tickerListeners} callbacks registered on the shared ticker, all invoked every frame.`,
        "See the Frames tab for which module owns them.",
        `${canvas.tickerListeners} listeners`);
    }
    if (canvas.renderer?.contextLost) {
      add(SEV.CRITICAL, "", "WebGL context is lost",
        "The renderer reports a lost WebGL context. The canvas will be blank or frozen until it is restored.",
        "Almost always GPU memory exhaustion. See texture memory above.",
        "context lost");
    }
  }

  src = "data";
  /* -- data / flags -------------------------------------------------------------------------- */
  if (data) {
    for (const f of data.flags) {
      if (f.bytes > 4 * 1024 * 1024) {
        add(SEV.CRITICAL, f.namespace, "Module flags are bloating world data",
          `${f.namespace} stores ${bytes(f.bytes)} of flags across ${f.docs} documents (${f.byType}). Biggest single document: ${f.biggest?.name} (${bytes(f.biggest?.bytes || 0)}).`,
          `This is loaded and parsed on every world load and re-sent on every relevant update.${!f.installed ? " This module is not even installed — the data is pure dead weight." : ""}`,
          bytes(f.bytes));
      } else if (f.bytes > 1024 * 1024) {
        add(SEV.WARN, f.namespace, "Sizeable module flag data",
          `${bytes(f.bytes)} across ${f.docs} documents (${f.byType}).`,
          !f.installed ? "This module is not installed; these flags are orphaned data you can safely purge." : "Normal for content modules; suspicious for utility modules.",
          bytes(f.bytes));
      } else if (!f.installed && f.bytes > 64 * 1024) {
        add(SEV.INFO, f.namespace, "Orphaned flags from an uninstalled module",
          `${bytes(f.bytes)} of flags from "${f.namespace}", which is not installed.`,
          "Dead weight in every document load. Safe to purge once you're sure you're not reinstalling it.",
          bytes(f.bytes));
      }
    }
    if (data.localStorage.totalBytes > 3 * 1024 * 1024) {
      const top = data.localStorage.byNamespace[0];
      add(SEV.WARN, top?.namespace || "", "localStorage is very full",
        `${bytes(data.localStorage.totalBytes)} used. Browsers cap this around 5-10 MB per origin; hitting the cap makes every client setting write throw.` +
        (top ? ` Largest namespace: ${top.namespace} (${bytes(top.bytes)}).` : ""),
        "Client-scoped settings live here. A module caching data in localStorage rather than settings is the usual cause.",
        bytes(data.localStorage.totalBytes));
    }
    const bigDocs = data.documents.filter((d) => d.bytes > 30 * 1024 * 1024);
    for (const d of bigDocs) {
      add(SEV.INFO, "", `Large ${d.type} collection`,
        `${d.count.toLocaleString()} documents totalling ${bytes(d.bytes)} of source data.`,
        d.type === "ChatMessage"
          ? "Chat history is loaded in full at world load. Purging old messages is one of the highest-value long-session fixes available."
          : "Consider moving rarely-used content into compendiums, which are loaded lazily.",
        bytes(d.bytes));
    }
    if ((data.documents.find((d) => d.type === "ChatMessage")?.count || 0) > 3000) {
      const c = data.documents.find((d) => d.type === "ChatMessage");
      add(SEV.WARN, "", "Very large chat history",
        `${c.count.toLocaleString()} stored chat messages (${bytes(c.bytes)}). All of them load into memory at world start.`,
        "Purge chat history between arcs. This directly reduces world-load time and baseline heap.",
        `${c.count.toLocaleString()} messages`);
    }
  }

  src = "input";
  /* -- input latency ------------------------------------------------------------------------ */
  //
  // Event Timing `duration` runs from the hardware timestamp to the next paint. For hover and
  // move events that is dominated by "when did the canvas next repaint", which on an active
  // Foundry canvas is meaningless as a latency signal. Only discrete interactions are used to
  // draw a conclusion, and the conclusion is anchored on handler time rather than total time.
  const allInputs = p.inputLatency?.toArray() || [];
  const inputs = allInputs.filter((i) => i.discrete);
  const hover = allInputs.filter((i) => !i.discrete);

  if (inputs.length >= 5) {
    const avgTotal = inputs.reduce((a, b) => a + b.dur, 0) / inputs.length;
    const avgProc = inputs.reduce((a, b) => a + (b.processing || 0), 0) / inputs.length;
    const avgDelay = inputs.reduce((a, b) => a + (b.delay || 0), 0) / inputs.length;
    const avgPresent = inputs.reduce((a, b) => a + (b.present || 0), 0) / inputs.length;
    const worst = inputs.reduce((a, b) => (b.dur > a.dur ? b : a));

    if (avgProc > 60 || avgDelay > 60) {
      // Name the dominant component, because the fix is completely different for each.
      const dominant = avgProc >= avgDelay && avgProc >= avgPresent ? "handler"
        : avgDelay >= avgPresent ? "queue" : "paint";
      const explain = dominant === "handler"
        ? "The time is going into the event handlers themselves — some module's click/keydown listener is doing real work synchronously."
        : dominant === "queue"
          ? "The time is going into *waiting to start*: the browser was busy finishing other work when you clicked. The handlers are fine; something else is blocking the main thread."
          : "The time is going into rendering after the handler finished. That points at canvas or layout cost, not at the handler.";
      add(SEV.WARN, "", "Slow response to discrete input",
        `${inputs.length} discrete interactions (clicks, key presses) exceeded 40 ms. ` +
        `Average total ${ms(avgTotal)} = ${ms(avgDelay)} queued + ${ms(avgProc)} in handlers + ${ms(avgPresent)} waiting to paint. ` +
        `Worst: ${ms(worst.dur)} (${worst.name}). ${explain}`,
        dominant === "queue"
          ? "Check the Timeline tab for long tasks overlapping those timestamps — that is what your click was waiting behind."
          : dominant === "handler"
            ? "Open this finding's detail window: it lists the instrumented callbacks that overlapped each slow interaction."
            : "Check the Canvas tab for filter count and texture memory, and the Frames tab for per-frame module cost.",
        `${ms(avgProc)} in handlers`);
    }
  }

  // Report hover-event noise separately and explicitly, so it is never mistaken for lag.
  if (hover.length >= 10 && inputs.length < 3) {
    const avgH = hover.reduce((a, b) => a + b.dur, 0) / hover.length;
    add(SEV.INFO, "", "Hover events reported as slow (usually not real lag)",
      `${hover.length} continuous events (${[...new Set(hover.map((h) => h.name))].slice(0, 4).join(", ")}) averaged ${ms(avgH)}, ` +
      `but only ${ms(hover.reduce((a, b) => a + (b.processing || 0), 0) / hover.length)} of that was spent in handlers. ` +
      `The remainder is time waiting for the next paint, which the Event Timing API includes in the total.`,
      "This is measurement noise on an actively-rendering canvas, not input lag. Judge responsiveness by discrete interactions (clicks, key presses) instead — the Frames tab separates the two.",
      `${ms(avgH)} avg, mostly paint wait`);
  }

  src = "socket";
  /* -- socket -------------------------------------------------------------------------------- */
  if (p.socket) {
    const emits = [...p.socket.emits.values()].sort((a, b) => b.count - a.count);
    const top = emits[0];
    if (top && top.count / Math.max(0.01, mins) > 120) {
      add(SEV.WARN, top.owner, "High socket traffic",
        `${top.count} "${top.event}" emissions (${bytes(top.bytes)}) — ${(top.count / mins).toFixed(0)}/min.`,
        "Every emission fans out to all connected clients. High-rate socket traffic degrades the whole table, and it is invisible in a single-client FPS graph.",
        `${(top.count / mins).toFixed(0)}/min`);
    }
  }

  out.sort((a, b) => b.sev - a.sev || a.owner.localeCompare(b.owner));
  return out;
}

/* ---------------------------------------------------------------------------------------- */
/* Snapshots                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/** A compact, diffable picture of the session at a moment in time. */
export function takeSnapshot(label, ctx) {
  const p = P();
  const s = ctx.samples?.[ctx.samples.length - 1] || {};
  return {
    label: label || new Date().toLocaleTimeString(),
    t: Date.now(),
    elapsedMin: (performance.now() - p.p0) / 60000,
    heap: s.heap || 0,
    fps: s.fps || 0,
    domNodes: s.domNodes || 0,
    listeners: s.listeners || 0,
    intervals: p.liveIntervals.size,
    canvasObjects: ctx.canvas?.totalObjects || 0,
    textureBytes: ctx.canvas?.textures?.bytes || 0,
    chatDom: s.chatDom || 0,
    apps: s.apps || 0,
    owners: (ctx.rows || []).map((r) => ({
      id: r.id, cpuMs: r.cpuMs, hookCalls: r.hookCalls, domOps: r.domOps,
      liveIntervals: r.liveIntervals, listenerRegs: r.listenerRegs, errors: r.errors,
      retainedBytes: r.retainedBytes
    }))
  };
}

export function diffSnapshots(a, b) {
  if (!a || !b) return null;
  const minutes = (b.t - a.t) / 60000;
  const num = (k) => ({ from: a[k], to: b[k], delta: (b[k] || 0) - (a[k] || 0) });
  const byId = new Map(a.owners.map((o) => [o.id, o]));
  const owners = b.owners.map((o) => {
    const prev = byId.get(o.id) || {};
    return {
      id: o.id,
      cpuMs: (o.cpuMs || 0) - (prev.cpuMs || 0),
      hookCalls: (o.hookCalls || 0) - (prev.hookCalls || 0),
      domOps: (o.domOps || 0) - (prev.domOps || 0),
      listenerRegs: (o.listenerRegs || 0) - (prev.listenerRegs || 0),
      liveIntervals: (o.liveIntervals || 0) - (prev.liveIntervals || 0),
      errors: (o.errors || 0) - (prev.errors || 0),
      retainedBytes: (o.retainedBytes || 0) - (prev.retainedBytes || 0)
    };
  }).filter((o) => o.cpuMs || o.hookCalls || o.domOps || o.listenerRegs || o.errors || o.retainedBytes)
    .sort((x, y) => y.cpuMs - x.cpuMs);

  return {
    minutes,
    heap: num("heap"),
    heapPerHour: minutes > 0 ? ((b.heap - a.heap) / minutes) * 60 : 0,
    fps: num("fps"),
    domNodes: num("domNodes"),
    listeners: num("listeners"),
    intervals: num("intervals"),
    canvasObjects: num("canvasObjects"),
    textureBytes: num("textureBytes"),
    chatDom: num("chatDom"),
    apps: num("apps"),
    owners
  };
}
