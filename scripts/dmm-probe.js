/**
 * DMM Performance Checker — Probe Core
 * ------------------------------------
 * This file is deliberately a CLASSIC script (module.json "scripts", not "esmodules").
 * Classic scripts are non-deferred and therefore execute before every `<script type="module">`
 * on the page, which means this runs before any other package's ESModule entry point.
 * That ordering is the entire basis of per-module attribution: we must own
 * Hooks.on / setTimeout / addEventListener / PIXI.Ticker.add BEFORE anyone calls them.
 *
 * Nothing here depends on `game`, `ui`, `canvas` or `CONFIG` existing yet. Globals that do not
 * exist at parse time (Hooks, PIXI, libWrapper, io) are captured with accessor traps that fire
 * the instant core or another package assigns them.
 *
 * Everything is stored on globalThis.DMMPC so the ESModule half of the module (and you, from
 * the console) can read it.
 */
"use strict";

(function () {
  if (globalThis.DMMPC?.installed) return;

  // ---------------------------------------------------------------------------------------
  // Constants + tiny helpers
  // ---------------------------------------------------------------------------------------
  const MODULE_ID = "dmm-performance-checker";
  const VERSION = "1.0.0";
  const now = performance.now.bind(performance);

  const CORE = "core";
  const UNKNOWN = "unattributed";

  /** Ring buffer with O(1) push and bounded memory. The probe must never be the leak. */
  class Ring {
    constructor(size) {
      this.size = size;
      this.buf = new Array(size);
      this.i = 0;
      this.n = 0;
    }
    push(v) {
      this.buf[this.i] = v;
      this.i = (this.i + 1) % this.size;
      if (this.n < this.size) this.n++;
      return v;
    }
    toArray() {
      const out = new Array(this.n);
      const start = (this.i - this.n + this.size) % this.size;
      for (let k = 0; k < this.n; k++) out[k] = this.buf[(start + k) % this.size];
      return out;
    }
    clear() {
      this.buf = new Array(this.size);
      this.i = 0;
      this.n = 0;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Configuration (read from localStorage so it is available before game.settings exists)
  // ---------------------------------------------------------------------------------------
  const CFG_KEY = `${MODULE_ID}.probeConfig`;
  const DEFAULT_CFG = {
    mode: "full",          // "full" | "envelope" | "off"
    domProbe: true,        // patch appendChild/insertBefore/removeChild/innerHTML/setItem
    tickerProbe: true,     // patch PIXI.Ticker.add / addOnce
    listenerProbe: true,   // patch EventTarget.addEventListener
    netProbe: true,        // patch fetch / XMLHttpRequest
    dbProbe: true,         // patch Document create/update/delete
    observerProbe: true,   // patch Mutation/Resize/IntersectionObserver + requestIdleCallback
    canvasProbe: false,    // patch PIXI.Container.addChild (heaviest; opt-in)
    overheadBudgetPct: 1.5,// self-throttle stack captures above this share of wall time
    spanThresholdMs: 1.5,  // record a timeline span when a single callback exceeds this
    sampleIntervalMs: 2000 // vitals sampling cadence
  };
  let CFG;
  try {
    CFG = Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(CFG_KEY) || "{}"));
  } catch (e) {
    CFG = Object.assign({}, DEFAULT_CFG);
  }

  // ---------------------------------------------------------------------------------------
  // Root state object
  // ---------------------------------------------------------------------------------------
  const P = {
    installed: true,
    version: VERSION,
    cfg: CFG,
    /** wall-clock + hi-res origin so samples can be correlated with real time */
    t0: Date.now(),
    p0: now(),
    /** True if we managed to patch Hooks before any package registered one. */
    early: false,
    /** Hook callbacks that existed before we patched (attribution blind spot). */
    preExisting: 0,
    /** owner id -> aggregate record */
    owners: new Map(),
    /** "hookName owner" -> record */
    hooks: new Map(),
    /** "event owner" -> record for DOM listeners */
    listeners: new Map(),
    /** owner -> ticker record */
    ticker: new Map(),
    /** owner -> network record */
    net: new Map(),
    /** owner -> database record */
    db: new Map(),
    /** live handle registries for leak detection */
    liveIntervals: new Map(),   // handle -> {owner, delay, created, fires, totalMs}
    liveTimeouts: new Map(),    // handle -> {owner, delay, created}
    liveListeners: new Map(),   // key -> {owner, type, target, count}
    /** rolling data */
    spans: new Ring(4000),      // {t, dur, self, owner, kind, label}
    longTasks: new Ring(500),   // {t, dur, attribution:[{owner,ms}]}
    frames: new Ring(3600),     // frame durations (ms)
    samples: new Ring(5400),    // vitals every sampleIntervalMs (~3h at 2s)
    errors: new Ring(300),      // {t, owner, message, stack}
    events: new Ring(400),      // {t, kind, text} — probe lifecycle log
    /** self-measurement */
    overhead: { stackMs: 0, stackCaptures: 0, wrapMs: 0, degraded: false, skipped: 0 },
    /** live mute set — hook/timer/listener/ticker callbacks owned by these ids become no-ops */
    muted: new Set(),
    /** context stack for nested attribution */
    ctx: [],
    /** enable flag; flipping to false makes every wrapper a straight pass-through */
    armed: CFG.mode !== "off",
    /** marker set to true once game.ready fires */
    ready: false,
    /** snapshot of globalThis keys before any package esmodule ran */
    baselineGlobals: null,
    /** counters that are not per-owner */
    global: {
      hookCalls: 0,
      hookCallbackInvocations: 0,
      domOps: 0,
      storageWrites: 0,
      storageBytes: 0,
      frames: 0,
      droppedFrames: 0
    },
    Ring
  };
  globalThis.DMMPC = P;

  function log(kind, text) {
    P.events.push({ t: Date.now(), kind, text });
  }

  // ---------------------------------------------------------------------------------------
  // Owner records
  // ---------------------------------------------------------------------------------------
  function newOwner(id) {
    return {
      id,
      // hook execution
      hookCalls: 0, hookTotal: 0, hookSelf: 0, hookMax: 0, hookMaxName: "",
      // registrations
      hookRegs: 0, hookRegsLive: 0,
      // timers
      timeoutRegs: 0, intervalRegs: 0, rafRegs: 0,
      timerCalls: 0, timerTotal: 0, timerSelf: 0, timerMax: 0,
      rafCalls: 0, rafTotal: 0,
      // observers + idle callbacks. Kept apart from `timer*` because their cost has a
      // different cause and a different fix: an observer fires because the page changed
      // under it, not because someone scheduled it.
      observerRegs: 0, observerCalls: 0, observerTotal: 0, observerSelf: 0, observerMax: 0,
      idleRegs: 0, idleCalls: 0, idleTotal: 0,
      // dom listeners
      listenerRegs: 0, listenerCalls: 0, listenerTotal: 0, listenerSelf: 0, listenerMax: 0,
      // libWrapper: tracked separately from hooks so a pass-through wrapper's envelope never
      // masquerades as hook cost
      lwCalls: 0, lwSelf: 0, lwInclusive: 0, lwMax: 0, lwMaxTarget: "",
      // pixi ticker
      tickerRegs: 0, tickerCalls: 0, tickerTotal: 0, tickerMax: 0,
      // dom mutation
      domOps: 0, domHtmlChars: 0, domRemovals: 0,
      // storage
      storageWrites: 0, storageBytes: 0,
      // network
      netRequests: 0, netBytes: 0, netTotal: 0,
      // database
      dbCreates: 0, dbUpdates: 0, dbDeletes: 0, dbDocs: 0, dbBytes: 0,
      // errors
      errors: 0,
      // long task overlap
      longTaskMs: 0,
      // muting bookkeeping
      mutedCalls: 0,
      // static asset cost (filled from resource timing)
      assetBytes: 0, assetMs: 0, assetCount: 0,
      // memory-ish
      retainedBytes: 0
    };
  }
  function owner(id) {
    let o = P.owners.get(id);
    if (!o) P.owners.set(id, (o = newOwner(id)));
    return o;
  }
  // Pre-create the buckets we always want visible.
  owner(CORE); owner(UNKNOWN);

  // ---------------------------------------------------------------------------------------
  // Attribution: parse a stack trace into a package id
  // ---------------------------------------------------------------------------------------
  const PKG_RE = /\/(modules|systems|worlds)\/([^/?#]+)\//;
  const SELF_RE = new RegExp(`/modules/${MODULE_ID}/`);
  /** Cache: a given stack line resolves to the same owner forever. */
  const lineCache = new Map();

  function ownerFromLine(line) {
    let hit = lineCache.get(line);
    if (hit !== undefined) return hit;
    let res = null;
    const m = PKG_RE.exec(line);
    if (m) {
      if (m[1] === "modules") res = m[2];
      else if (m[1] === "systems") res = `system:${m[2]}`;
      else res = "world-script";
    } else if (/\/(scripts|client|common)\/|foundry\.(js|mjs)|\bblob:/.test(line)) {
      res = CORE;
    }
    if (lineCache.size < 20000) lineCache.set(line, res);
    return res;
  }

  /**
   * Resolve the package responsible for the code that called us.
   * Skips frames belonging to this probe and to Foundry core so that a module calling
   * `Hooks.on` through a core helper is still credited to the module.
   */
  function attribute() {
    if (!P.armed) return UNKNOWN;
    // Self-throttle: stack capture is the only genuinely expensive thing we do.
    // Note the guard is evaluated in `sample()`, not here, and only once there is a
    // measurement window long enough for the ratio to mean anything.
    if (P.overhead.degraded && (P.overhead.stackCaptures & 15) !== 0) {
      P.overhead.stackCaptures++;
      P.overhead.skipped++;
      return UNKNOWN;
    }
    const s0 = now();
    let stack;
    try {
      stack = new Error().stack || "";
    } catch (e) {
      return UNKNOWN;
    }
    const lines = stack.split("\n");
    let core = null;
    let result = UNKNOWN;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (SELF_RE.test(line)) continue;           // never blame ourselves
      const o = ownerFromLine(line);
      if (o === null) continue;
      if (o === CORE) { if (core === null) core = CORE; continue; } // remember, keep looking
      result = o;
      break;
    }
    if (result === UNKNOWN && core) result = CORE;

    const dt = now() - s0;
    P.overhead.stackMs += dt;
    P.overhead.stackCaptures++;
    return result;
  }

  /** Cheap attribution for repeat callers: cache by function identity. */
  const fnOwner = new WeakMap();
  function attributeFn(fn) {
    if (typeof fn !== "function" && typeof fn !== "object") return attribute();
    let o = fnOwner.get(fn);
    if (o === undefined) {
      o = attribute();
      // Never cache a failure: if sampling was degraded when we first saw this function we
      // want another chance at it later rather than marking it unattributed forever.
      if (o !== UNKNOWN) { try { fnOwner.set(fn, o); } catch (e) { /* non-weakable */ } }
    }
    return o;
  }

  // ---------------------------------------------------------------------------------------
  // Context stack — the keystone.
  // Every instrumented callback pushes its owner. Anything that happens synchronously
  // underneath (DOM writes, DB writes, fetches, storage writes, nested hooks) is credited to
  // the top of this stack for free, with no extra stack captures.
  // ---------------------------------------------------------------------------------------
  const ctx = P.ctx;
  function currentOwner() {
    return ctx.length ? ctx[ctx.length - 1].owner : (P.ready ? CORE : CORE);
  }
  function enter(ownerId) {
    ctx.push({ owner: ownerId, child: 0 });
    return now();
  }
  function leave(t0, kind, label, quiet) {
    const frame = ctx.pop();
    // Underflow should be impossible, but callers destructure the result, so never return a
    // scalar here — a profiler that throws inside someone else's hook is unforgivable.
    if (!frame) return { dur: 0, self: 0 };
    const dur = now() - t0;
    const self = dur - frame.child;
    const parent = ctx[ctx.length - 1];
    if (parent) parent.child += dur;
    if (!quiet && dur >= CFG.spanThresholdMs) {
      P.spans.push({ t: Date.now(), p: t0, dur, self, owner: frame.owner, kind, label });
    }
    return { dur, self };
  }

  // ---------------------------------------------------------------------------------------
  // Deferred global patching: run `fn(value)` as soon as `globalThis[name]` exists.
  // ---------------------------------------------------------------------------------------
  const pendingGlobals = new Map();
  function whenGlobal(name, fn) {
    if (globalThis[name] !== undefined) { safe(() => fn(globalThis[name]), `whenGlobal:${name}`); return; }
    if (pendingGlobals.has(name)) { pendingGlobals.get(name).push(fn); return; }
    pendingGlobals.set(name, [fn]);
    let stored;
    let defined = false;
    try {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: true,
        get() { return stored; },
        set(v) {
          stored = v;
          if (!defined) {
            defined = true;
            // Restore a plain data property first so patchers see normal semantics.
            try {
              Object.defineProperty(globalThis, name, {
                configurable: true, enumerable: true, writable: true, value: v
              });
            } catch (e) { /* keep accessor */ }
            const fns = pendingGlobals.get(name) || [];
            pendingGlobals.delete(name);
            for (const f of fns) safe(() => f(globalThis[name]), `whenGlobal:${name}`);
          }
        }
      });
    } catch (e) {
      // Non-configurable already — polling is the only option.
    }
    // Belt and braces. The accessor above is bypassed entirely if core assigns the global with
    // Object.defineProperty rather than plain assignment, and we cannot know which it does
    // across generations. The poll is cheap and self-cancels the moment the accessor fires.
    pollFor(name);
  }
  function pollFor(name) {
    let tries = 0;
    const tick = () => {
      if (globalThis[name] !== undefined) {
        const fns = pendingGlobals.get(name) || [];
        pendingGlobals.delete(name);
        for (const f of fns) safe(() => f(globalThis[name]), `poll:${name}`);
        return;
      }
      if (++tries > 6000) return;
      rawSetTimeout(tick, 10);
    };
    rawSetTimeout(tick, 0);
  }
  function safe(fn, label) {
    try { return fn(); } catch (e) {
      log("error", `${label}: ${e?.message || e}`);
      if (globalThis.console) console.warn(`${MODULE_ID} | ${label}`, e);
    }
  }

  // Keep pristine references BEFORE we patch anything.
  const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
  const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const rawSetInterval = globalThis.setInterval.bind(globalThis);
  const rawRAF = (globalThis.requestAnimationFrame || function (f) { return rawSetTimeout(f, 16); }).bind(globalThis);
  P._raw = { setTimeout: rawSetTimeout, clearTimeout: rawClearTimeout, setInterval: rawSetInterval, requestAnimationFrame: rawRAF };

  // Snapshot the global namespace before packages load, so we can diff later.
  try { P.baselineGlobals = new Set(Object.getOwnPropertyNames(globalThis)); } catch (e) { /* ignore */ }

  if (!P.armed) {
    log("info", "Probe disarmed by configuration (mode=off).");
    return;
  }

  // =======================================================================================
  // 1. HOOKS
  // =======================================================================================
  const wrappedToOriginal = new WeakMap();
  const originalToWrapped = new WeakMap();
  /**
   * Hook registration id -> wrapped callback.
   *
   * `Hooks.on` returns a numeric id, and both core and packages unregister by that id rather
   * than by function reference: v14's `Hooks.#call` auto-removes a `once` entry with
   * `this.off(hook, id)`. Without this map those removals are invisible and `hookRegsLive`
   * only ever climbs, which is exactly the false leak signal this probe exists to debunk.
   */
  const idToWrapped = new Map();

  function hookRec(hookName, ownerId) {
    const key = hookName + " " + ownerId;
    let r = P.hooks.get(key);
    if (!r) {
      P.hooks.set(key, (r = {
        hook: hookName, owner: ownerId,
        calls: 0, total: 0, self: 0, max: 0, muted: 0, errors: 0,
        live: 0, regs: 0, lastT: 0
      }));
    }
    return r;
  }

  function wrapHookCallback(hookName, fn, once, ownerId) {
    if (typeof fn !== "function") return fn;
    // Already one of ours for this same hook. This is the `once` path: core's `Hooks.once` is
    // `return this.on(hook, fn, {once: true})`, and `this.on` is the patched one, so a
    // pre-wrapped callback comes straight back through here. Wrapping it a second time
    // double-counted every registration and every call, doubled `hookTotal`, and — worse —
    // left `Hooks.events` holding a function that `originalToWrapped` could not resolve, so
    // `Hooks.off(hook, fn)` silently failed and the callback stayed registered forever.
    // `__dmmCounted` rather than `__dmmWrapped` because `envelope` mode builds no wrapper and
    // must not double-count either.
    if (fn.__dmmCounted && fn.__dmmHook === hookName) return fn;
    const existing = originalToWrapped.get(fn);
    if (existing && existing.__dmmHook === hookName) return existing;

    const o = owner(ownerId);
    const rec = hookRec(hookName, ownerId);
    rec.regs++; rec.live++;
    o.hookRegs++; o.hookRegsLive++;

    if (CFG.mode !== "full") {
      // Envelope mode: no per-callback timing, but the registration is still counted once and
      // must still be resolvable when it is unregistered.
      try {
        fn.__dmmCounted = true;
        fn.__dmmHook = hookName;
        fn.__dmmOwner = ownerId;
        fn.__dmmOnce = !!once;
      } catch (e) { /* frozen */ }
      return fn;
    }

    // A `once` callback is unregistered by core the moment it fires. Release it from the live
    // count exactly once, whether it goes out via the id path or is never removed at all.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (rec.live > 0) rec.live--;
      if (o.hookRegsLive > 0) o.hookRegsLive--;
    };

    const wrapped = function (...args) {
      if (once) release();
      if (!P.armed) return fn.apply(this, args);
      if (P.muted.has(ownerId)) { rec.muted++; o.mutedCalls++; return undefined; }
      const t0 = enter(ownerId);
      P.global.hookCallbackInvocations++;
      let out;
      try {
        out = fn.apply(this, args);
      } catch (err) {
        rec.errors++; o.errors++;
        recordError(ownerId, err, `hook:${hookName}`);
        leave(t0, "hook", hookName);
        throw err;
      }
      const r = leave(t0, "hook", hookName);
      rec.calls++; rec.total += r.dur; rec.self += r.self;
      if (r.dur > rec.max) rec.max = r.dur;
      o.hookCalls++; o.hookTotal += r.dur; o.hookSelf += r.self;
      if (r.dur > o.hookMax) { o.hookMax = r.dur; o.hookMaxName = hookName; }
      return out;
    };
    Object.defineProperty(wrapped, "name", { value: fn.name || "anonymous", configurable: true });
    wrapped.__dmmWrapped = true;
    wrapped.__dmmCounted = true;
    wrapped.__dmmHook = hookName;
    wrapped.__dmmOwner = ownerId;
    wrapped.__dmmOriginal = fn;
    wrapped.__dmmOnce = !!once;
    wrapped.__dmmRelease = release;
    wrappedToOriginal.set(wrapped, fn);
    originalToWrapped.set(fn, wrapped);
    return wrapped;
  }

  /** Drop a registration from the live counters, given the wrapped callback core is holding. */
  function releaseHookRegistration(wrapped) {
    if (typeof wrapped?.__dmmRelease === "function") { wrapped.__dmmRelease(); return; }
    // `envelope` mode never builds a wrapper, so fall back to the plain counters.
    const ownerId = wrapped?.__dmmOwner;
    if (typeof ownerId !== "string") return;
    const rec = P.hooks.get(wrapped.__dmmHook + " " + ownerId);
    if (rec && rec.live > 0) rec.live--;
    const o = P.owners.get(ownerId);
    if (o && o.hookRegsLive > 0) o.hookRegsLive--;
  }

  function patchHooks(H) {
    if (!H || H.__dmmPatched) return;
    H.__dmmPatched = true;

    // How many callbacks were already registered before we got here?
    try {
      const ev = H.events || {};
      for (const k of Object.keys(ev)) {
        const arr = ev[k];
        P.preExisting += Array.isArray(arr) ? arr.length : 0;
      }
    } catch (e) { /* ignore */ }
    P.early = P.preExisting === 0;
    log("info", `Hooks patched. Pre-existing callbacks: ${P.preExisting} (early=${P.early}).`);

    const _on = H.on.bind(H);
    const _once = H.once ? H.once.bind(H) : null;
    const _off = H.off.bind(H);

    /** Shared by `on` and `once`; `once` is authoritative when either source says so. */
    const register = (call, hook, fn, options, forceOnce) => {
      // An already-wrapped callback arriving here is core's `once` delegating into `on`.
      // Trust the tag rather than paying for another stack capture.
      const ownerId = typeof fn?.__dmmOwner === "string" ? fn.__dmmOwner : attributeFn(fn);
      const once = !!(forceOnce || options?.once || fn?.__dmmOnce);
      const w = wrapHookCallback(hook, fn, once, ownerId);
      const id = call(hook, w, options);
      if (typeof id === "number" && typeof w === "function") {
        idToWrapped.set(id, w);
        try { w.__dmmId = id; } catch (e) { /* frozen */ }
      }
      return id;
    };

    H.on = function (hook, fn, options) {
      return register(_on, hook, fn, options, false);
    };
    if (_once) {
      H.once = function (hook, fn, options) {
        // Core's `once` delegates to `this.on`, i.e. straight back through the wrapper above.
        // `register` is idempotent for an already-wrapped callback, so the second pass adds
        // no counters and hands core the very function `originalToWrapped` can resolve.
        return register(_once, hook, fn, options, true);
      };
    }
    H.off = function (hook, fn) {
      let target = fn;
      // Unregistration by id: core's own `once` auto-removal takes this path.
      if (typeof fn === "number") {
        const w = idToWrapped.get(fn);
        if (w) { releaseHookRegistration(w); idToWrapped.delete(fn); }
        return _off(hook, fn);
      }
      if (typeof fn === "function") {
        const w = fn.__dmmCounted ? fn : originalToWrapped.get(fn);
        if (w) {
          target = w;
          // Keep the id map the same size as core's own, never larger.
          if (typeof w.__dmmId === "number") idToWrapped.delete(w.__dmmId);
        }
        releaseHookRegistration(w || fn);
      }
      return _off(hook, target);
    };

    // Envelope timing: how often each hook fires and what it costs in aggregate.
    for (const method of ["callAll", "call"]) {
      if (typeof H[method] !== "function") continue;
      const orig = H[method].bind(H);
      H[method] = function (hook, ...args) {
        if (!P.armed) return orig(hook, ...args);
        P.global.hookCalls++;
        let e = P.hookEnvelope.get(hook);
        if (!e) P.hookEnvelope.set(hook, (e = { hook, calls: 0, total: 0, max: 0 }));
        const t0 = now();
        try {
          return orig(hook, ...args);
        } finally {
          const d = now() - t0;
          e.calls++; e.total += d;
          if (d > e.max) e.max = d;
        }
      };
    }

    // Retry the globals-dependent patches at well-known lifecycle points. `PIXI` and
    // `foundry.abstract.Document` may not be ready (or fully populated) when their globals are
    // first assigned, and both must be patched before the canvas draws or any module writes.
    for (const hook of ["init", "setup", "canvasInit", "ready"]) {
      try { H.once(hook, ensureLatePatches); } catch (e) { /* ignore */ }
    }
  }

  function ensureLatePatches() {
    if (!P._pixiPatched && globalThis.PIXI) safe(() => patchPixi(globalThis.PIXI), "late PIXI patch");
    if (!P._dbPatched && globalThis.foundry) safe(() => attachDbPatches(globalThis.foundry), "late DB patch");
  }
  P.hookEnvelope = new Map();
  whenGlobal("Hooks", patchHooks);

  // =======================================================================================
  // 2. TIMERS  (setTimeout / setInterval / requestAnimationFrame)
  // =======================================================================================
  function patchTimers() {
    const _setTimeout = globalThis.setTimeout;
    const _setInterval = globalThis.setInterval;
    const _clearTimeout = globalThis.clearTimeout;
    const _clearInterval = globalThis.clearInterval;
    const _raf = globalThis.requestAnimationFrame;
    const _caf = globalThis.cancelAnimationFrame;

    globalThis.setTimeout = function (fn, delay, ...rest) {
      if (typeof fn !== "function" || !P.armed) return _setTimeout.apply(globalThis, arguments);
      const ownerId = currentOwnerOrStack(fn);
      const o = owner(ownerId);
      o.timeoutRegs++;
      let handle;
      const wrapped = function (...a) {
        P.liveTimeouts.delete(handle);
        if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
        runTimed(ownerId, o, "timeout", fn, this, a, `setTimeout(${delay | 0}ms)`);
      };
      handle = _setTimeout.call(globalThis, wrapped, delay, ...rest);
      P.liveTimeouts.set(handle, { owner: ownerId, delay: delay | 0, created: Date.now() });
      return handle;
    };

    globalThis.setInterval = function (fn, delay, ...rest) {
      if (typeof fn !== "function" || !P.armed) return _setInterval.apply(globalThis, arguments);
      const ownerId = currentOwnerOrStack(fn);
      const o = owner(ownerId);
      o.intervalRegs++;
      let handle;
      const wrapped = function (...a) {
        const meta = P.liveIntervals.get(handle);
        if (meta) meta.fires++;
        if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
        const r = runTimed(ownerId, o, "interval", fn, this, a, `setInterval(${delay | 0}ms)`);
        if (meta && r) meta.totalMs += r.dur;
      };
      handle = _setInterval.call(globalThis, wrapped, delay, ...rest);
      P.liveIntervals.set(handle, { owner: ownerId, delay: delay | 0, created: Date.now(), fires: 0, totalMs: 0 });
      return handle;
    };

    globalThis.clearTimeout = function (h) { P.liveTimeouts.delete(h); return _clearTimeout.call(globalThis, h); };
    globalThis.clearInterval = function (h) { P.liveIntervals.delete(h); return _clearInterval.call(globalThis, h); };

    if (typeof _raf === "function") {
      globalThis.requestAnimationFrame = function (fn) {
        if (typeof fn !== "function" || !P.armed) return _raf.apply(globalThis, arguments);
        const ownerId = currentOwnerOrStack(fn);
        const o = owner(ownerId);
        o.rafRegs++;
        return _raf.call(globalThis, function (ts) {
          if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
          const t0 = enter(ownerId);
          try { return fn.call(this, ts); }
          catch (err) { recordError(ownerId, err, "requestAnimationFrame"); throw err; }
          finally {
            const r = leave(t0, "raf", "requestAnimationFrame");
            o.rafCalls++; o.rafTotal += r.dur;
          }
        });
      };
      if (typeof _caf === "function") globalThis.cancelAnimationFrame = _caf.bind(globalThis);
    }
  }

  /**
   * Prefer the context stack (free, exact) and only fall back to a stack capture when we are
   * at top level (e.g. a module scheduling a timer from its module body).
   */
  function currentOwnerOrStack(fn) {
    if (ctx.length) return ctx[ctx.length - 1].owner;
    return attributeFn(fn);
  }

  function runTimed(ownerId, o, kind, fn, thisArg, args, label) {
    const t0 = enter(ownerId);
    try {
      fn.apply(thisArg, args);
    } catch (err) {
      recordError(ownerId, err, kind);
      leave(t0, kind, label);
      throw err;
    }
    const r = leave(t0, kind, label);
    o.timerCalls++; o.timerTotal += r.dur; o.timerSelf += r.self;
    if (r.dur > o.timerMax) o.timerMax = r.dur;
    return r;
  }
  patchTimers();

  // =======================================================================================
  // 2b. OBSERVERS + IDLE CALLBACKS
  //
  // MutationObserver, ResizeObserver and IntersectionObserver callbacks are scheduled by the
  // browser rather than by the module, so nothing on the context stack attributes them and
  // every one of them landed in `unattributed`. They are worth owning: a MutationObserver on
  // a busy subtree, or a ResizeObserver that writes layout back, is a classic cause of jank
  // that no amount of hook or ticker instrumentation will explain.
  //
  // Attribution happens at *construction*, which is the point where the calling module is on
  // the stack — by the time the callback runs the stack is browser-internal.
  // =======================================================================================
  P.observers = new Map(); // "Kind owner" -> record

  function observerRec(kind, ownerId) {
    const key = kind + " " + ownerId;
    let r = P.observers.get(key);
    if (!r) {
      P.observers.set(key, (r = {
        kind, owner: ownerId, constructed: 0, live: 0,
        calls: 0, records: 0, total: 0, max: 0
      }));
    }
    return r;
  }

  function patchObservers() {
    if (!CFG.observerProbe) return;
    // Deliberately not PerformanceObserver: the long-task and event-timing observers in
    // section 11 are our own, and `attribute()` skips this module's frames by design, so we
    // would end up billing whichever package happened to be below us on the stack.
    const kinds = ["MutationObserver", "ResizeObserver", "IntersectionObserver"];
    for (const kind of kinds) {
      const Orig = globalThis[kind];
      if (typeof Orig !== "function") continue;

      const Patched = function (callback, ...rest) {
        if (!P.armed || typeof callback !== "function") return new Orig(callback, ...rest);
        const ownerId = currentOwnerOrStack(callback);
        const o = owner(ownerId);
        const rec = observerRec(kind, ownerId);
        rec.constructed++; rec.live++;
        o.observerRegs++;

        const wrapped = function (records, obs, ...a) {
          if (!P.armed) return callback.call(this, records, obs, ...a);
          if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
          const t0 = enter(ownerId);
          try { return callback.call(this, records, obs, ...a); }
          catch (err) { recordError(ownerId, err, kind); throw err; }
          finally {
            const r = leave(t0, "observer", kind);
            rec.calls++;
            rec.records += Array.isArray(records) ? records.length
              : (records && typeof records.length === "number" ? records.length : 1);
            rec.total += r.dur;
            if (r.dur > rec.max) rec.max = r.dur;
            o.observerCalls++; o.observerTotal += r.dur; o.observerSelf += r.self;
            if (r.dur > o.observerMax) o.observerMax = r.dur;
          }
        };

        const inst = new Orig(wrapped, ...rest);
        try {
          Object.defineProperty(inst, "__dmmOwner", { value: ownerId, configurable: true, enumerable: false });
          const _disconnect = inst.disconnect;
          if (typeof _disconnect === "function") {
            inst.disconnect = function () { if (rec.live > 0) rec.live--; return _disconnect.apply(this, arguments); };
          }
        } catch (e) { /* sealed host object */ }
        return inst;
      };
      Patched.prototype = Orig.prototype;
      // Carry over any statics the platform or packages read off the constructor.
      try {
        for (const k of Object.getOwnPropertyNames(Orig)) {
          if (["length", "name", "prototype"].includes(k)) continue;
          const d = Object.getOwnPropertyDescriptor(Orig, k);
          if (d) Object.defineProperty(Patched, k, d);
        }
      } catch (e) { /* ignore */ }
      Object.defineProperty(Patched, "name", { value: kind, configurable: true });
      try { globalThis[kind] = Patched; } catch (e) { /* non-writable */ }
    }

    // requestIdleCallback: work a module deliberately deferred, which still runs on the main
    // thread and still shows up as a stutter if it overruns its deadline.
    const _ric = globalThis.requestIdleCallback;
    if (typeof _ric === "function") {
      globalThis.requestIdleCallback = function (fn, opts) {
        if (!P.armed || typeof fn !== "function") return _ric.apply(globalThis, arguments);
        const ownerId = currentOwnerOrStack(fn);
        const o = owner(ownerId);
        o.idleRegs++;
        return _ric.call(globalThis, function (deadline) {
          if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
          const t0 = enter(ownerId);
          try { return fn.call(this, deadline); }
          catch (err) { recordError(ownerId, err, "requestIdleCallback"); throw err; }
          finally {
            const r = leave(t0, "idle", "requestIdleCallback");
            o.idleCalls++; o.idleTotal += r.dur;
          }
        }, opts);
      };
    }
    log("info", "Observer probe attached.");
  }
  patchObservers();

  // =======================================================================================
  // 3. DOM EVENT LISTENERS
  // =======================================================================================
  /** Very hot event types get counted but not individually timed unless they are slow. */
  const HOT_EVENTS = new Set(["mousemove", "pointermove", "wheel", "touchmove", "drag", "dragover", "scroll"]);

  /**
   * Is this a Window or Document belonging to one of v14's detached (pop-out) windows?
   *
   * These matter for two separate reasons. The retention advice on the DOM tab says that a
   * climbing count on `window` or `document` is the real leak because those outlive any
   * application — but a pop-out's window and document do not, they die when the user closes
   * the pop-out. Labelling them plainly as "Window"/"HTMLDocument" hid that distinction, and
   * treating them as permanently live made their listeners look retained forever.
   */
  function detachedHost(t) {
    if (!t || t === globalThis || t === document) return null;
    try {
      if (typeof Window !== "undefined" && t instanceof Window) return t;
      if (t.nodeType === 9 && t.defaultView) return t.defaultView;
    } catch (e) { /* cross-origin */ }
    return null;
  }

  function targetLabel(t) {
    try {
      if (t === globalThis) return "window";
      if (t === document) return "document";
      const host = detachedHost(t);
      if (host) return t.nodeType === 9 ? "detached-document" : "detached-window";
      if (t && t.nodeType === 1) {
        const id = t.id ? `#${t.id}` : "";
        const cls = typeof t.className === "string" && t.className ? `.${t.className.trim().split(/\s+/)[0]}` : "";
        // An element inside a pop-out is still element churn, but say where it lives.
        const where = t.ownerDocument && t.ownerDocument !== document ? "@detached " : "";
        return `${where}${t.tagName.toLowerCase()}${id}${cls}`;
      }
      return t?.constructor?.name || "other";
    } catch (e) { return "other"; }
  }

  function listenerRec(type, ownerId) {
    const key = type + " " + ownerId;
    let r = P.listeners.get(key);
    if (!r) {
      P.listeners.set(key, (r = {
        type, owner: ownerId,
        regs: 0,
        // `live` = added minus explicitly removed. This is NOT a leak count: Foundry
        // applications throw their whole element away on close without calling
        // removeEventListener, so `live` climbs by thousands per sheet open and never falls,
        // even though nothing is actually retained.
        live: 0,
        // `attached` = registrations whose target is still connected to the document. This is
        // the number that actually means something. See sweepListeners().
        attached: 0,
        orphaned: 0,      // target was destroyed or garbage collected — benign
        untracked: 0,     // registrations beyond the WeakRef budget (coverage gap, NOT a count)
        aborted: 0,       // removed via AbortSignal rather than removeEventListener
        calls: 0, total: 0, max: 0,
        targets: new Map(),      // cumulative registrations by target label
        attachedBy: [],          // [label, count] of *currently attached* targets
        sampleStacks: new Map(), // target label -> one registration stack, for locating the code
        refs: []                 // [{r: WeakRef<EventTarget>, l: label}]
      }));
    }
    return r;
  }

  // Budget for target WeakRefs. Generous enough to be representative, bounded so the profiler
  // cannot itself become the memory problem it is looking for.
  const REF_BUDGET = 40000;
  const REF_PER_REC = 4000;
  P._refTotal = 0;

  /**
   * Decide whether a registration still holds anything.
   *
   * A listener on an element that has been removed from the document is not a leak — the
   * element and its listeners will be collected. A listener on window, document, or an element
   * still in the tree, that was never removed, is.
   */
  function refIsLive(entry) {
    const t = entry.r.deref();
    if (t === undefined) return false;                     // collected
    if (t === globalThis || t === document) return true;
    // A v14 pop-out window (and its document) stops being live the moment it is closed. The
    // old `return true` fallback for non-Node EventTargets kept them counted forever, which
    // manufactured a leak every time someone popped a sheet out and closed it again.
    const host = detachedHost(t);
    if (host) { try { return host.closed !== true; } catch (e) { return false; } }
    if (t && t.nodeType === 1) return t.isConnected === true;
    if (t && typeof t.isConnected === "boolean") return t.isConnected;
    return true;                                            // non-DOM EventTarget
  }

  /** Sweep the whole registry. Cheap enough (a deref plus a boolean read per entry). */
  function sweepListeners() {
    let tracked = 0, untracked = 0;
    for (const rec of P.listeners.values()) {
      if (!rec.refs.length) {
        rec.attached = 0;
        rec.attachedBy = [];
        untracked += rec.untracked;
        continue;
      }
      const keep = [];
      const by = new Map();
      let dropped = 0;
      for (const entry of rec.refs) {
        if (refIsLive(entry)) { keep.push(entry); by.set(entry.l, (by.get(entry.l) || 0) + 1); }
        else dropped++;
      }
      P._refTotal -= dropped;
      rec.orphaned += dropped;
      rec.refs = keep;
      rec.attached = keep.length;
      rec.attachedBy = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      tracked += keep.length;
      untracked += rec.untracked;
    }
    // Honest coverage figure. If this drops well below 1 the attached counts are a sample, not
    // a census, and the UI says so rather than quietly under-reporting.
    P.listenerCoverage = tracked + untracked > 0 ? tracked / (tracked + untracked) : 1;
    P.listenerUntracked = untracked;
  }
  P.sweepListeners = sweepListeners;

  /**
   * Total listeners still attached to something live.
   *
   * Deliberately does NOT add `untracked`. That counter is cumulative and never decreases, so
   * including it made this total monotonically increasing once the WeakRef budget was exhausted
   * — which reproduced, in the profiler, exactly the "listeners never go down" symptom it exists
   * to diagnose. Coverage is reported separately instead.
   */
  function totalAttachedListeners() {
    let n = 0;
    for (const r of P.listeners.values()) n += r.attached;
    return n;
  }

  function patchListeners() {
    if (!CFG.listenerProbe) return;
    const proto = EventTarget.prototype;
    const _add = proto.addEventListener;
    const _remove = proto.removeEventListener;
    const map = new WeakMap(); // listener -> Map(type -> wrapped)

    proto.addEventListener = function (type, listener, options) {
      if (!P.armed || typeof listener !== "function") return _add.apply(this, arguments);
      const ownerId = currentOwnerOrStack(listener);
      const o = owner(ownerId);
      const rec = listenerRec(type, ownerId);
      rec.regs++; rec.live++;
      o.listenerRegs++;
      const tl = targetLabel(this);
      rec.targets.set(tl, (rec.targets.get(tl) || 0) + 1);

      // Record the target weakly so we can later tell "never removed" from "still holding
      // something". Without this, opening and closing one character sheet permanently adds
      // thousands to the live count and looks exactly like a leak.
      let entry = null;
      if (typeof WeakRef === "function" && rec.refs.length < REF_PER_REC && P._refTotal < REF_BUDGET) {
        try {
          entry = { r: new WeakRef(this), l: tl };
          rec.refs.push(entry);
          P._refTotal++;
        } catch (e) { rec.untracked++; entry = null; }
      } else {
        rec.untracked++;
      }

      // Keep one registration stack per (event, package, target kind). This is what turns
      // "2,400 click listeners on document" into "…registered from module/foo/sheet.js:212".
      if (!rec.sampleStacks.has(tl) && rec.sampleStacks.size < 8) {
        try {
          const st = (new Error().stack || "").split("\n").slice(2, 8)
            .filter((l) => !SELF_RE.test(l)).join("\n");
          rec.sampleStacks.set(tl, st);
        } catch (e) { /* ignore */ }
      }

      // Foundry v13+ removes listeners by aborting an AbortSignal rather than calling
      // removeEventListener. Without this the registration would look permanent forever.
      const opts = arguments[2];
      const signal = opts && typeof opts === "object" ? opts.signal : null;
      if (signal && typeof signal.addEventListener === "function" && !signal.aborted) {
        try {
          _add.call(signal, "abort", () => {
            rec.aborted++;
            if (rec.live > 0) rec.live--;
            if (entry) {
              const i = rec.refs.indexOf(entry);
              if (i >= 0) { rec.refs.splice(i, 1); P._refTotal--; }
            }
          }, { once: true });
        } catch (e) { /* ignore */ }
      }

      let byType = map.get(listener);
      if (!byType) map.set(listener, (byType = new Map()));
      let wrapped = byType.get(type);
      if (!wrapped) {
        const hot = HOT_EVENTS.has(type);
        wrapped = function (ev) {
          if (!P.armed) return listener.call(this, ev);
          if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
          const t0 = enter(ownerId);
          try { return listener.call(this, ev); }
          catch (err) { recordError(ownerId, err, `listener:${type}`); throw err; }
          finally {
            const r = leave(t0, hot ? "listener-hot" : "listener", type);
            rec.calls++; rec.total += r.dur;
            if (r.dur > rec.max) rec.max = r.dur;
            o.listenerCalls++; o.listenerTotal += r.dur; o.listenerSelf += r.self;
            if (r.dur > o.listenerMax) o.listenerMax = r.dur;
          }
        };
        wrapped.__dmmOwner = ownerId;
        byType.set(type, wrapped);
      }
      return _add.call(this, type, wrapped, options);
    };

    proto.removeEventListener = function (type, listener, options) {
      if (typeof listener === "function") {
        const byType = map.get(listener);
        const wrapped = byType && byType.get(type);
        if (wrapped) {
          const rec = P.listeners.get(type + " " + wrapped.__dmmOwner);
          if (rec) {
            if (rec.live > 0) rec.live--;
            // Drop one WeakRef pointing at this target. Bounded scan from the end, because an
            // unbounded one would make mass-removal quadratic.
            const start = Math.max(0, rec.refs.length - 250);
            for (let i = rec.refs.length - 1; i >= start; i--) {
              if (rec.refs[i].r.deref() === this) { rec.refs.splice(i, 1); P._refTotal--; break; }
            }
          }
          return _remove.call(this, type, wrapped, options);
        }
      }
      return _remove.apply(this, arguments);
    };
  }
  patchListeners();

  // =======================================================================================
  // 4. DOM MUTATION + STORAGE  (attributed for free via the context stack)
  // =======================================================================================
  function patchDom() {
    if (!CFG.domProbe) return;
    const nproto = Node.prototype;
    const _append = nproto.appendChild;
    const _insert = nproto.insertBefore;
    const _remove = nproto.removeChild;
    const _replace = nproto.replaceChild;

    function bump(n, removal) {
      if (!P.armed) return;
      P.global.domOps += n;
      const o = owner(currentOwner());
      o.domOps += n;
      if (removal) o.domRemovals += n;
    }

    nproto.appendChild = function (c) { bump(1, false); return _append.call(this, c); };
    nproto.insertBefore = function (c, r) { bump(1, false); return _insert.call(this, c, r); };
    nproto.removeChild = function (c) { bump(1, true); return _remove.call(this, c); };
    nproto.replaceChild = function (a, b) { bump(2, false); return _replace.call(this, a, b); };

    const ihDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (ihDesc && ihDesc.set) {
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: ihDesc.enumerable,
        get: ihDesc.get,
        set: function (v) {
          if (P.armed) {
            const o = owner(currentOwner());
            o.domOps++;
            o.domHtmlChars += typeof v === "string" ? v.length : 0;
            P.global.domOps++;
          }
          return ihDesc.set.call(this, v);
        }
      });
    }

    const iahDesc = Element.prototype.insertAdjacentHTML;
    if (typeof iahDesc === "function") {
      Element.prototype.insertAdjacentHTML = function (pos, html) {
        if (P.armed) {
          const o = owner(currentOwner());
          o.domOps++;
          o.domHtmlChars += typeof html === "string" ? html.length : 0;
          P.global.domOps++;
        }
        return iahDesc.call(this, pos, html);
      };
    }

    // localStorage / sessionStorage writes are synchronous disk-backed I/O on the main thread.
    // A module writing a client setting every frame will absolutely destroy a long session.
    const sproto = Storage.prototype;
    const _setItem = sproto.setItem;
    sproto.setItem = function (k, v) {
      if (P.armed) {
        const o = owner(currentOwner());
        const bytes = (String(k).length + String(v).length) * 2;
        o.storageWrites++; o.storageBytes += bytes;
        P.global.storageWrites++; P.global.storageBytes += bytes;
      }
      return _setItem.call(this, k, v);
    };
  }
  patchDom();

  // =======================================================================================
  // 5. NETWORK  (fetch + XHR)
  // =======================================================================================
  function netRec(id) {
    let r = P.net.get(id);
    if (!r) P.net.set(id, (r = { owner: id, requests: 0, bytes: 0, total: 0, max: 0, byPath: new Map(), errors: 0 }));
    return r;
  }
  function patchNetwork() {
    if (!CFG.netProbe) return;
    if (typeof globalThis.fetch === "function") {
      const _fetch = globalThis.fetch;
      globalThis.fetch = function (input, init) {
        if (!P.armed) return _fetch.apply(globalThis, arguments);
        const ownerId = currentOwner() === CORE && ctx.length === 0 ? attribute() : currentOwner();
        const o = owner(ownerId);
        const rec = netRec(ownerId);
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const t0 = now();
        rec.requests++; o.netRequests++;
        const short = shortenUrl(url);
        rec.byPath.set(short, (rec.byPath.get(short) || 0) + 1);
        const pr = _fetch.apply(globalThis, arguments);
        return pr.then((resp) => {
          const d = now() - t0;
          rec.total += d; o.netTotal += d;
          if (d > rec.max) rec.max = d;
          const len = Number(resp.headers?.get?.("content-length")) || 0;
          rec.bytes += len; o.netBytes += len;
          return resp;
        }, (err) => { rec.errors++; throw err; });
      };
    }
    if (typeof globalThis.XMLHttpRequest === "function") {
      const XHR = globalThis.XMLHttpRequest;
      const _open = XHR.prototype.open;
      const _send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__dmmUrl = url;
        this.__dmmOwner = ctx.length ? currentOwner() : attribute();
        return _open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        if (P.armed && this.__dmmOwner) {
          const rec = netRec(this.__dmmOwner);
          const o = owner(this.__dmmOwner);
          rec.requests++; o.netRequests++;
          const short = shortenUrl(this.__dmmUrl || "");
          rec.byPath.set(short, (rec.byPath.get(short) || 0) + 1);
          const t0 = now();
          this.addEventListener("loadend", () => {
            const d = now() - t0;
            rec.total += d; o.netTotal += d;
            if (d > rec.max) rec.max = d;
            const len = Number(this.getResponseHeader?.("content-length")) || 0;
            rec.bytes += len; o.netBytes += len;
          });
        }
        return _send.apply(this, arguments);
      };
    }
  }
  function shortenUrl(u) {
    try {
      const s = String(u).split("?")[0];
      const parts = s.split("/").filter(Boolean);
      return "/" + parts.slice(-3).join("/");
    } catch (e) { return "?"; }
  }
  patchNetwork();

  // =======================================================================================
  // 6. DATABASE WRITES
  // =======================================================================================
  function dbRec(id) {
    let r = P.db.get(id);
    if (!r) P.db.set(id, (r = { owner: id, creates: 0, updates: 0, deletes: 0, docs: 0, bytes: 0, byType: new Map(), embedded: 0 }));
    return r;
  }
  function patchDatabase() {
    if (!CFG.dbProbe) return;
    whenGlobal("foundry", attachDbPatches);
  }
  function attachDbPatches(F) {
    if (P._dbPatched || !CFG.dbProbe) return;
    {
      const Doc = F?.abstract?.Document;
      // The `foundry` namespace can be assigned before `abstract.Document` is populated,
      // depending on core's own module graph. Bail quietly; ensureLatePatches will retry.
      if (!Doc) return;
      P._dbPatched = true;
      const statics = ["createDocuments", "updateDocuments", "deleteDocuments"];
      for (const name of statics) {
        if (typeof Doc[name] !== "function") continue;
        const orig = Doc[name];
        Doc[name] = function (data, operation) {
          if (P.armed) {
            const ownerId = ctx.length ? currentOwner() : attribute();
            const rec = dbRec(ownerId);
            const o = owner(ownerId);
            const count = Array.isArray(data) ? data.length : 1;
            rec.docs += count; o.dbDocs += count;
            if (name === "createDocuments") { rec.creates++; o.dbCreates++; }
            else if (name === "updateDocuments") { rec.updates++; o.dbUpdates++; }
            else { rec.deletes++; o.dbDeletes++; }
            const type = this?.documentName || operation?.parent?.documentName || "?";
            rec.byType.set(type, (rec.byType.get(type) || 0) + count);
            if (name !== "deleteDocuments") {
              let bytes = 0;
              try { bytes = JSON.stringify(data)?.length || 0; } catch (e) { bytes = 0; }
              rec.bytes += bytes; o.dbBytes += bytes;
            }
          }
          return orig.apply(this, arguments);
        };
        Doc[name].__dmmPatched = true;
      }
      // Embedded document operations route through the parent document instance.
      const proto = Doc.prototype;
      for (const name of ["createEmbeddedDocuments", "updateEmbeddedDocuments", "deleteEmbeddedDocuments"]) {
        if (typeof proto[name] !== "function") continue;
        const orig = proto[name];
        proto[name] = function (embeddedName, data) {
          if (P.armed) {
            const ownerId = ctx.length ? currentOwner() : attribute();
            const rec = dbRec(ownerId);
            rec.embedded += Array.isArray(data) ? data.length : 1;
            rec.byType.set(embeddedName, (rec.byType.get(embeddedName) || 0) + (Array.isArray(data) ? data.length : 1));
          }
          return orig.apply(this, arguments);
        };
      }
      log("info", "Database probe attached.");
    }
  }
  patchDatabase();

  // =======================================================================================
  // 7. PIXI TICKER + CANVAS
  //    Ticker.add is called rarely but its callbacks run every single frame, which makes it
  //    the highest-leverage, lowest-cost place to instrument frame cost.
  // =======================================================================================
  function tickRec(id) {
    let r = P.ticker.get(id);
    if (!r) P.ticker.set(id, (r = { owner: id, regs: 0, live: 0, calls: 0, total: 0, max: 0, fns: new Map() }));
    return r;
  }
  function patchPixi(PX) {
    if (!PX || P._pixiPatched) return;
    P._pixiPatched = true;
    P.pixiVersion = PX.VERSION || "unknown";
    if (CFG.tickerProbe && PX.Ticker?.prototype?.add) {
      const TP = PX.Ticker.prototype;
      const _add = TP.add;
      const _addOnce = TP.addOnce;
      const _remove = TP.remove;
      const wmap = new WeakMap();

      function makeWrapped(fn, ctxObj, ownerId) {
        const o = owner(ownerId);
        const rec = tickRec(ownerId);
        rec.regs++; rec.live++;
        o.tickerRegs++;
        const label = fn.name || "anonymous";
        rec.fns.set(label, (rec.fns.get(label) || 0) + 1);
        const wrapped = function (...a) {
          if (!P.armed) return fn.apply(this, a);
          if (P.muted.has(ownerId)) { o.mutedCalls++; return; }
          const t0 = enter(ownerId);
          try { return fn.apply(this, a); }
          catch (err) { recordError(ownerId, err, "ticker"); throw err; }
          finally {
            const r = leave(t0, "ticker", label);
            rec.calls++; rec.total += r.dur;
            if (r.dur > rec.max) rec.max = r.dur;
            o.tickerCalls++; o.tickerTotal += r.dur;
            if (r.dur > o.tickerMax) o.tickerMax = r.dur;
          }
        };
        wrapped.__dmmOwner = ownerId;
        wmap.set(fn, wrapped);
        return wrapped;
      }

      TP.add = function (fn, ctxObj, priority) {
        if (!P.armed || typeof fn !== "function") return _add.apply(this, arguments);
        const ownerId = currentOwnerOrStack(fn);
        return _add.call(this, wmap.get(fn) || makeWrapped(fn, ctxObj, ownerId), ctxObj, priority);
      };
      if (typeof _addOnce === "function") {
        TP.addOnce = function (fn, ctxObj, priority) {
          if (!P.armed || typeof fn !== "function") return _addOnce.apply(this, arguments);
          const ownerId = currentOwnerOrStack(fn);
          return _addOnce.call(this, wmap.get(fn) || makeWrapped(fn, ctxObj, ownerId), ctxObj, priority);
        };
      }
      if (typeof _remove === "function") {
        TP.remove = function (fn, ctxObj) {
          const w = typeof fn === "function" ? wmap.get(fn) : null;
          if (w) {
            const rec = P.ticker.get(w.__dmmOwner);
            if (rec && rec.live > 0) rec.live--;
            return _remove.call(this, w, ctxObj);
          }
          return _remove.apply(this, arguments);
        };
      }
      log("info", `PIXI ticker probe attached (PIXI ${P.pixiVersion}).`);
    }

    // Optional: tag canvas display objects with their creator so the census can attribute them.
    if (CFG.canvasProbe && PX.Container?.prototype?.addChild) {
      const CP = PX.Container.prototype;
      const _addChild = CP.addChild;
      const ctorOwner = new WeakMap();
      CP.addChild = function (...children) {
        if (P.armed) {
          const fallback = ctx.length ? currentOwner() : null;
          for (const c of children) {
            if (!c || c.__dmmOwner) continue;
            let id = fallback;
            if (!id) {
              const ctor = c.constructor;
              id = ctorOwner.get(ctor);
              if (id === undefined) { id = attribute(); try { ctorOwner.set(ctor, id); } catch (e) {} }
            }
            try { Object.defineProperty(c, "__dmmOwner", { value: id, configurable: true, enumerable: false }); }
            catch (e) { /* frozen */ }
          }
        }
        return _addChild.apply(this, children);
      };
      log("info", "Canvas addChild probe attached (deep mode).");
    }
  }
  whenGlobal("PIXI", patchPixi);

  // =======================================================================================
  // 8. libWrapper registrations
  // =======================================================================================
  P.libWrapper = new Map(); // "target" -> [record]

  /**
   * Does this wrapper type receive the next function in the chain as its first argument?
   * WRAPPER and MIXED do; OVERRIDE and LISTENER do not.
   */
  function takesNext(LW, type) {
    if (type === undefined || type === null) return true;          // defaults to MIXED
    if (typeof type === "string") {
      const t = type.toUpperCase();
      return t === "WRAPPER" || t === "MIXED";
    }
    if (LW.WRAPPER !== undefined) return type === LW.WRAPPER || type === LW.MIXED;
    return true;
  }

  whenGlobal("libWrapper", (LW) => {
    if (!LW || typeof LW.register !== "function" || LW.__dmmPatched) return;
    LW.__dmmPatched = true;
    const _register = LW.register.bind(LW);

    LW.register = function (packageId, target, fn, type, options) {
      const key = String(target);
      let list = P.libWrapper.get(key);
      if (!list) P.libWrapper.set(key, (list = []));
      const wantsNext = takesNext(LW, type);
      const rec = {
        owner: packageId, target: key,
        type: typeof type === "string" ? type : (wantsNext ? "WRAPPER/MIXED" : "OVERRIDE/LISTENER"),
        calls: 0,
        // `inclusive` is the whole envelope: this wrapper plus everything downstream of it.
        // `self` is this wrapper's own code only. For a pass-through wrapper the two differ by
        // orders of magnitude, and only `self` is a fair charge against the package.
        inclusive: 0, self: 0, max: 0, maxSelf: 0, passThrough: 0
      };
      list.push(rec);
      const o = owner(packageId);

      const wrapped = function (...args) {
        if (!P.armed) return fn.apply(this, args);
        if (P.muted.has(packageId)) {
          o.mutedCalls++;
          // For WRAPPER/MIXED the first arg is the next function in the chain; call through so
          // muting a package does not simply delete the core behaviour it wraps.
          if (wantsNext && typeof args[0] === "function") return args[0].apply(this, args.slice(1));
          return undefined;
        }

        const t0 = enter(packageId);

        // The important bit. libWrapper's WRAPPER type means `args[0]` is the rest of the chain,
        // ending in the original core function. A wrapper that merely calls through — and
        // libWrapper itself registers exactly such a wrapper on Application.prototype._render
        // to catch render errors — would otherwise be billed for every application render in
        // the entire session.
        //
        // Pushing a synthetic frame around the downstream call moves that time into this
        // frame's `child` total, so `self` becomes the wrapper's genuine exclusive cost, and
        // anything the downstream code does (DOM writes, document updates) is attributed to
        // core or to the next instrumented wrapper rather than to this package.
        if (wantsNext && typeof args[0] === "function") {
          const nextFn = args[0];
          args = args.slice();
          args[0] = function (...a) {
            const dt = enter(CORE);
            try { return nextFn.apply(this, a); }
            finally { rec.passThrough += leave(dt, "downstream", key, true).dur; }
          };
        }

        try { return fn.apply(this, args); }
        catch (err) { recordError(packageId, err, `libWrapper:${key}`); throw err; }
        finally {
          const r = leave(t0, "libwrapper", key);
          rec.calls++;
          rec.inclusive += r.dur;
          rec.self += r.self;
          if (r.dur > rec.max) rec.max = r.dur;
          if (r.self > rec.maxSelf) rec.maxSelf = r.self;
          o.lwCalls++;
          o.lwSelf += r.self;
          o.lwInclusive += r.dur;
          if (r.self > o.lwMax) { o.lwMax = r.self; o.lwMaxTarget = key; }
        }
      };
      Object.defineProperty(wrapped, "name", { value: fn.name || "wrapper", configurable: true });
      return _register(packageId, target, wrapped, type, options);
    };
    log("info", "libWrapper probe attached.");
  });

  // =======================================================================================
  // 9. SOCKET traffic
  // =======================================================================================
  P.socket = { emits: new Map(), receives: new Map(), bytesOut: 0, bytesIn: 0 };
  function attachSocket(sock) {
    if (!sock || sock.__dmmPatched) return;
    sock.__dmmPatched = true;
    const _emit = sock.emit?.bind(sock);
    if (_emit) {
      sock.emit = function (ev, ...args) {
        if (P.armed) {
          const ownerId = ctx.length ? currentOwner() : attribute();
          const key = ev + " " + ownerId;
          let r = P.socket.emits.get(key);
          if (!r) P.socket.emits.set(key, (r = { event: ev, owner: ownerId, count: 0, bytes: 0 }));
          r.count++;
          let b = 0;
          try { b = JSON.stringify(args)?.length || 0; } catch (e) { b = 0; }
          r.bytes += b; P.socket.bytesOut += b;
        }
        return _emit(ev, ...args);
      };
    }
    if (typeof sock.onAny === "function") {
      sock.onAny((ev, ...args) => {
        let r = P.socket.receives.get(ev);
        if (!r) P.socket.receives.set(ev, (r = { event: ev, count: 0, bytes: 0 }));
        r.count++;
        let b = 0;
        try { b = JSON.stringify(args)?.length || 0; } catch (e) { b = 0; }
        r.bytes += b; P.socket.bytesIn += b;
      });
    }
    log("info", "Socket probe attached.");
  }
  P.attachSocket = attachSocket;

  // =======================================================================================
  // 10. ERRORS
  // =======================================================================================
  const errorSeen = new Map(); // signature -> count (dedupe storms)
  function recordError(ownerId, err, where) {
    try {
      const msg = (err && (err.message || String(err))) || "unknown";
      const sig = ownerId + "|" + where + "|" + msg.slice(0, 120);
      const c = (errorSeen.get(sig) || 0) + 1;
      errorSeen.set(sig, c);
      owner(ownerId).errors++;
      // Only store the first few of each signature; storms are counted, not stored.
      if (c <= 3) {
        P.errors.push({ t: Date.now(), owner: ownerId, where, message: msg, stack: (err && err.stack || "").split("\n").slice(0, 6).join("\n"), count: c });
      }
    } catch (e) { /* never throw from the error recorder */ }
  }
  P.recordError = recordError;
  P.errorSignatures = errorSeen;

  globalThis.addEventListener("error", (ev) => {
    const line = ev.filename ? `at (${ev.filename}:${ev.lineno}:${ev.colno})` : "";
    const id = ownerFromLine(line) || (ev.error?.stack ? firstOwnerInStack(ev.error.stack) : null) || UNKNOWN;
    recordError(id, ev.error || new Error(ev.message), "window.onerror");
  });
  globalThis.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    const id = (reason?.stack ? firstOwnerInStack(reason.stack) : null) || UNKNOWN;
    recordError(id, reason instanceof Error ? reason : new Error(String(reason)), "unhandledrejection");
  });
  function firstOwnerInStack(stack) {
    const lines = String(stack).split("\n");
    for (const l of lines) {
      if (SELF_RE.test(l)) continue;
      const o = ownerFromLine(l);
      if (o && o !== CORE) return o;
    }
    return null;
  }

  // =======================================================================================
  // 11. FRAME TIMING + LONG TASKS + VITALS SAMPLING
  // =======================================================================================
  let lastFrame = now();
  let frameAccum = 0, frameCount = 0, jank = 0, worstFrame = 0;
  (function frameLoop() {
    const t = now();
    const d = t - lastFrame;
    lastFrame = t;
    if (d > 0 && d < 2000) {
      P.frames.push(d);
      frameAccum += d; frameCount++;
      if (d > worstFrame) worstFrame = d;
      P.global.frames++;
      // A "dropped frame" is relative to this display's actual vsync interval, not to 60 Hz.
      if (d > P.frameBudgetMs * 2) { jank++; P.global.droppedFrames++; }
    }
    rawRAF(frameLoop);
  })();

  /**
   * Browser capability detection.
   *
   * Several of the most useful signals here are Chromium-only. Rather than silently reporting
   * zeros — which reads as "no problem" when it actually means "no data" — record what is
   * available and let the UI say so explicitly.
   */
  const supported = (PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
  P.capabilities = {
    heap: !!performance.memory,
    longTask: supported.includes("longtask"),
    eventTiming: supported.includes("event"),
    layoutShift: supported.includes("layout-shift"),
    // navigator.clipboard is undefined entirely on non-secure origins, which is how most people
    // reach a self-hosted Foundry (http://192.168.x.x:30000 rather than localhost or https).
    asyncClipboard: !!globalThis.navigator?.clipboard?.writeText,
    secureContext: !!globalThis.isSecureContext,
    manualGC: typeof globalThis.gc === "function",
    engine: /firefox/i.test(navigator.userAgent) ? "firefox"
      : /electron/i.test(navigator.userAgent) ? "electron"
        : /chrome|chromium|edg/i.test(navigator.userAgent) ? "chromium"
          : /safari/i.test(navigator.userAgent) ? "safari" : "unknown"
  };
  P.heapAvailable = P.capabilities.heap;
  log("info", `Capabilities: ${Object.entries(P.capabilities).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  // Long tasks: >50ms blocks of main-thread work. Attributed by overlapping timeline spans.
  if (typeof PerformanceObserver === "function") {
    safe(() => {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const start = e.startTime, end = e.startTime + e.duration;
          const spans = P.spans.toArray();
          const acc = new Map();
          for (let i = spans.length - 1; i >= 0 && i > spans.length - 400; i--) {
            const s = spans[i];
            if (!s) continue;
            const sEnd = s.p + s.dur;
            if (sEnd < start) break;
            if (s.p > end) continue;
            const overlap = Math.min(end, sEnd) - Math.max(start, s.p);
            if (overlap > 0) acc.set(s.owner, (acc.get(s.owner) || 0) + Math.min(overlap, s.self));
          }
          const attribution = [...acc.entries()]
            .map(([o, ms]) => ({ owner: o, ms }))
            .sort((a, b) => b.ms - a.ms)
            .slice(0, 5);
          for (const a of attribution) owner(a.owner).longTaskMs += a.ms;
          P.longTasks.push({ t: Date.now(), start, dur: e.duration, attribution });
        }
      });
      po.observe({ entryTypes: ["longtask"] });
      P._longTaskObserver = po;
    }, "longtask observer");

    // Event Timing: how long the UI took to respond to a real interaction.
    //
    // Important caveat, learned the hard way: `entry.duration` is measured from the hardware
    // timestamp to the *next paint*, rounded up to 8 ms. For continuous/hover events like
    // pointerout and pointermove that means it mostly measures "time until Foundry's canvas
    // next repaints", not time spent handling anything. On a busy canvas those entries look
    // alarming and mean nothing. We keep them, but we mark them, and the analysis only draws
    // conclusions from discrete interactions and from `processing` time.
    P.inputLatency = new Ring(400);
    const DISCRETE = new Set([
      "click", "auxclick", "dblclick", "contextmenu",
      "pointerdown", "pointerup", "mousedown", "mouseup",
      "keydown", "keyup", "keypress",
      "input", "change", "submit",
      "touchstart", "touchend"
    ]);
    safe(() => {
      const po2 = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < 40) continue;
          const processing = (e.processingEnd || 0) - (e.processingStart || 0);
          P.inputLatency.push({
            t: Date.now(),
            start: e.startTime,
            end: e.startTime + e.duration,
            name: e.name,
            dur: e.duration,
            processing,
            delay: (e.processingStart || 0) - e.startTime,
            // Time between the handler finishing and the next paint. Large values here mean
            // rendering was the bottleneck, not the event handler.
            present: Math.max(0, e.duration - processing - ((e.processingStart || 0) - e.startTime)),
            discrete: DISCRETE.has(e.name),
            interactionId: e.interactionId || 0
          });
        }
      });
      po2.observe({ type: "event", durationThreshold: 40, buffered: true });
      P._eventObserver = po2;
    }, "event timing observer");
  }

  /**
   * Estimate the display refresh rate rather than assuming 60 Hz.
   *
   * This matters more than it sounds: on a 165 Hz monitor the frame budget is 6.1 ms, not
   * 16.7 ms, so a module costing 3 ms/frame is eating half the budget rather than a fifth.
   * Hardcoding 60 Hz would have understated per-frame cost by nearly 3x on such a display.
   *
   * The 20th percentile of frame deltas is used because the fastest frames represent the true
   * vsync interval; the mean is polluted by jank. The result is snapped to a known rate only
   * when it is close to one.
   */
  function estimateRefresh() {
    const f = P.frames.toArray().filter((x) => x > 1 && x < 100);
    if (f.length < 60) return null;
    const s = f.slice().sort((a, b) => a - b);
    const p20 = s[Math.floor(s.length * 0.2)];
    if (!p20) return null;
    const hz = 1000 / p20;
    const common = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 180, 240, 360];
    let best = common[0], bd = Infinity;
    for (const c of common) { const d = Math.abs(c - hz); if (d < bd) { bd = d; best = c; } }
    return bd / best < 0.1 ? best : Math.round(hz);
  }
  P.refreshHz = 60;
  P.frameBudgetMs = 1000 / 60;
  P.refreshDetected = false;

  // Vitals sampling
  function sample() {
    const mem = performance.memory;
    const frames = P.frames.toArray();
    const avg = frameCount ? frameAccum / frameCount : 0;

    sweepListeners();

    const hz = estimateRefresh();
    if (hz) {
      P.refreshHz = hz;
      P.frameBudgetMs = 1000 / hz;
      P.refreshDetected = true;
    }
    P.heapAvailable = !!mem;

    const s = {
      t: Date.now(),
      p: now(),
      heap: mem ? mem.usedJSHeapSize : 0,
      heapTotal: mem ? mem.totalJSHeapSize : 0,
      heapLimit: mem ? mem.jsHeapSizeLimit : 0,
      fps: avg > 0 ? 1000 / avg : 0,
      worstFrame,
      jank,
      frames: frameCount,
      domNodes: safeCount(),
      listeners: totalLiveListeners(),
      listenersAttached: totalAttachedListeners(),
      intervals: P.liveIntervals.size,
      timeouts: P.liveTimeouts.size,
      hookCalls: P.global.hookCallbackInvocations,
      domOps: P.global.domOps,
      chatMessages: globalThis.game?.messages?.size || 0,
      chatDom: chatDomCount(),
      apps: appCount(),
      overheadPct: overheadPct()
    };
    P.samples.push(s);
    frameAccum = 0; frameCount = 0; jank = 0; worstFrame = 0;

    // Self-throttle if we are costing too much.
    //
    // The ratio is meaningless over a tiny window: a single 0.05 ms stack capture in the first
    // 2 ms of page life reads as 2.5% and would disable attribution for the whole session.
    // Require both a real time window and a real sample count before acting, and allow the
    // decision to be reversed if the load that caused it goes away.
    const elapsed = now() - P.p0;
    const pct = overheadPct();
    const measurable = elapsed > 20000 && P.overhead.stackCaptures > 1000;
    if (measurable) {
      if (!P.overhead.degraded && pct > CFG.overheadBudgetPct) {
        P.overhead.degraded = true;
        log("warn", `Probe overhead ${pct.toFixed(2)}% exceeded the ${CFG.overheadBudgetPct}% budget; stack capture degraded to 1-in-16 sampling.`);
      } else if (P.overhead.degraded && pct < CFG.overheadBudgetPct * 0.5) {
        P.overhead.degraded = false;
        log("info", `Probe overhead back down to ${pct.toFixed(2)}%; full attribution restored.`);
      }
    }
  }
  function overheadPct() {
    const elapsed = now() - P.p0;
    return elapsed > 0 ? (P.overhead.stackMs / elapsed) * 100 : 0;
  }
  function safeCount() {
    try { return document.getElementsByTagName("*").length; } catch (e) { return 0; }
  }
  /**
   * Rendered chat messages, as a leak indicator.
   *
   * v14 renders the same messages twice — the sidebar tab and the floating chat-notifications
   * panel are both `.chat-log` — so a union selector double-counted every message and made a
   * healthy session look like a runaway one. Take the largest single log instead.
   */
  function chatDomCount() {
    try {
      let most = 0;
      for (const log of document.querySelectorAll(".chat-log")) {
        const n = log.querySelectorAll(".chat-message").length;
        if (n > most) most = n;
      }
      return most;
    } catch (e) { return 0; }
  }
  function totalLiveListeners() {
    let n = 0;
    for (const r of P.listeners.values()) n += r.live;
    return n;
  }
  function appCount() {
    try {
      const v2 = globalThis.foundry?.applications?.instances?.size || 0;
      const v1 = Object.keys(globalThis.ui?.windows || {}).length;
      return v2 + v1;
    } catch (e) { return 0; }
  }
  P.sample = sample;
  P._sampleTimer = rawSetInterval(sample, CFG.sampleIntervalMs);
  sample();

  // =======================================================================================
  // 12. Control surface used by the dashboard
  // =======================================================================================
  /**
   * Listener retention baseline.
   *
   * The intended use is a controlled experiment: mark a baseline, open and close a sheet, then
   * read the delta. Anything still attached afterwards genuinely survived the close, and the
   * per-target breakdown says what it is attached to.
   */
  P.markListenerBaseline = function () {
    sweepListeners();
    const snap = new Map();
    for (const [k, r] of P.listeners) snap.set(k, { attached: r.attached, live: r.live, regs: r.regs });
    P.listenerBaseline = { t: Date.now(), snap, totalAttached: totalAttachedListeners() };
    log("info", `Listener baseline marked: ${P.listenerBaseline.totalAttached} attached.`);
    return P.listenerBaseline;
  };
  P.clearListenerBaseline = function () { P.listenerBaseline = null; };

  /** Per-(event, package) delta since the baseline, sorted by what grew most. */
  P.listenerDelta = function () {
    if (!P.listenerBaseline) return null;
    sweepListeners();
    const out = [];
    for (const [k, r] of P.listeners) {
      const b = P.listenerBaseline.snap.get(k) || { attached: 0, live: 0, regs: 0 };
      const dAttached = r.attached - b.attached;
      const dRegs = r.regs - b.regs;
      if (!dAttached && !dRegs) continue;
      out.push({
        key: k, type: r.type, owner: r.owner,
        attachedDelta: dAttached, regsDelta: dRegs, liveDelta: r.live - b.live,
        attached: r.attached, untracked: r.untracked,
        attachedBy: r.attachedBy,
        // A registration that was added and is still attached to a persistent target is the
        // shape of a genuine leak; one added and already gone is normal element churn.
        retainedRatio: dRegs > 0 ? dAttached / dRegs : 0,
        stacks: [...r.sampleStacks.entries()]
      });
    }
    out.sort((a, b) => b.attachedDelta - a.attachedDelta);
    return {
      sinceMs: Date.now() - P.listenerBaseline.t,
      totalAttachedDelta: totalAttachedListeners() - P.listenerBaseline.totalAttached,
      rows: out
    };
  };

  P.mute = function (id) { P.muted.add(id); log("mute", `Muted ${id}`); };
  P.unmute = function (id) { P.muted.delete(id); log("mute", `Unmuted ${id}`); };
  P.unmuteAll = function () { P.muted.clear(); log("mute", "Unmuted all"); };

  P.resetCounters = function () {
    for (const o of P.owners.values()) Object.assign(o, newOwner(o.id));
    P.hooks.clear(); P.listeners.clear(); P.ticker.clear(); P.observers.clear();
    P.net.clear(); P.db.clear(); P.hookEnvelope.clear();
    P.spans.clear(); P.longTasks.clear(); P.frames.clear();
    P.global.hookCalls = 0; P.global.hookCallbackInvocations = 0;
    P.global.domOps = 0; P.global.storageWrites = 0; P.global.storageBytes = 0;
    P.global.frames = 0; P.global.droppedFrames = 0;
    P.overhead.stackMs = 0; P.overhead.stackCaptures = 0; P.overhead.skipped = 0;
    P.overhead.degraded = false;
    P.p0 = now();
    log("info", "Counters reset.");
  };

  P.setConfig = function (patch) {
    Object.assign(CFG, patch);
    try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch (e) { /* ignore */ }
  };

  log("info", `DMM Performance Checker probe ${VERSION} installed (mode=${CFG.mode}).`);
  if (globalThis.console) {
    console.log(`%c${MODULE_ID}%c probe installed — mode ${CFG.mode}. Inspect with globalThis.DMMPC`,
      "background:#4b2e83;color:#fff;padding:2px 5px;border-radius:3px", "color:inherit");
  }
})();
