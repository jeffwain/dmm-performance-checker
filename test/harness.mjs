/**
 * Minimal Foundry/DOM harness so the probe can be exercised outside a browser.
 * This is not a Foundry emulator — it implements only the surfaces the probe patches, which is
 * exactly enough to prove the instrumentation and attribution logic works.
 *
 * Run:  node --experimental-vm-modules test/run.mjs
 */

export function installHarness() {
  /* ---- storage ---- */
  class Storage {
    constructor() { this._m = new Map(); }
    setItem(k, v) { this._m.set(String(k), String(v)); }
    getItem(k) { return this._m.has(String(k)) ? this._m.get(String(k)) : null; }
    removeItem(k) { this._m.delete(String(k)); }
    key(i) { return [...this._m.keys()][i] ?? null; }
    get length() { return this._m.size; }
  }
  globalThis.Storage = Storage;
  globalThis.localStorage = new Storage();

  /* ---- DOM ---- */
  // Extends EventTarget so the listener probe can be exercised against realistic targets.
  class FakeNode extends EventTarget {
    constructor(tag = "div") {
      super();
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.id = "";
      this.className = "";
      this._html = "";
      this.isConnected = true;
    }
    appendChild(c) { this.children.push(c); return c; }
    insertBefore(c) { this.children.unshift(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
    replaceChild(a, b) { const i = this.children.indexOf(b); if (i >= 0) this.children[i] = a; return b; }
    insertAdjacentHTML(pos, html) { this._html += html; }
    getElementsByTagName() { return { length: this.children.length }; }
    /** Descendants matching a single class selector (".foo") — enough for the chat-log tests. */
    _matches(sel) {
      if (!sel.startsWith(".")) return false;
      return String(this.className).split(/\s+/).includes(sel.slice(1));
    }
    _collect(sel, out) {
      for (const c of this.children) {
        if (typeof c._matches === "function" && c._matches(sel)) out.push(c);
        if (typeof c._collect === "function") c._collect(sel, out);
      }
      return out;
    }
    querySelector(sel) { return this._collect(sel, [])[0] || null; }
    querySelectorAll(sel) { return this._collect(sel, []); }
    get childElementCount() { return this.children.length; }
  }
  Object.defineProperty(FakeNode.prototype, "innerHTML", {
    configurable: true,
    get() { return this._html; },
    set(v) { this._html = v; }
  });
  globalThis.Node = FakeNode;
  globalThis.Element = FakeNode;
  const mainDocument = Object.assign(new FakeNode("body"), {
    body: new FakeNode("body"),
    visibilityState: "visible",
    styleSheets: [],
    contains: () => true,
    createElement: (t) => new FakeNode(t),
    getElementsByTagName: () => ({ length: 1 })
  });
  // Make `body` a real child of the document so descendant queries from the document reach it,
  // the way they do in a browser. Done before the probe is installed, so it costs no counters.
  mainDocument.appendChild(mainDocument.body);
  globalThis.document = mainDocument;

  /* ---- window-ish ---- */
  const winTarget = new EventTarget();
  globalThis.addEventListener = winTarget.addEventListener.bind(winTarget);
  globalThis.removeEventListener = winTarget.removeEventListener.bind(winTarget);
  globalThis.dispatchEvent = winTarget.dispatchEvent.bind(winTarget);

  /**
   * v14 detached (pop-out) windows. A real one is a separate browser window with its own
   * document; what matters to the probe is that it is an EventTarget which is `instanceof
   * Window`, has a `closed` flag, and owns a document that is not the main one.
   */
  class Window extends EventTarget {
    constructor(id) {
      super();
      this.id = id;
      this.closed = false;
      const doc = new FakeNode("body");
      doc.nodeType = 9;
      doc.defaultView = this;
      doc.body = new FakeNode("body");
      this.document = doc;
    }
    close() { this.closed = true; }
  }
  globalThis.Window = Window;
  /** Open a detached window and register it the way DetachedWindowManager does. */
  globalThis.__openDetachedWindow = (id = `win-${Math.random().toString(36).slice(2, 7)}`) => {
    const win = new Window(id);
    globalThis.foundry.applications.detached.windows.set(id, { window: win, applications: new Map() });
    return win;
  };

  /**
   * Observers. Real ones are driven by the browser; these expose `_fire()` so a test can
   * deliver records at a moment of its choosing, which is the only part the probe cares about.
   */
  for (const kind of ["MutationObserver", "ResizeObserver", "IntersectionObserver"]) {
    const Obs = class {
      constructor(cb) { this._cb = cb; this._targets = []; this.disconnected = false; }
      observe(t) { this._targets.push(t); }
      disconnect() { this.disconnected = true; }
      takeRecords() { return []; }
      _fire(records = [{}]) { return this._cb(records, this); }
    };
    Object.defineProperty(Obs, "name", { value: kind, configurable: true });
    globalThis[kind] = Obs;
  }
  globalThis.requestIdleCallback = (fn) => setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: false }), 1);
  globalThis.cancelIdleCallback = (h) => clearTimeout(h);

  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
    globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
  }
  if (!performance.memory) {
    let used = 100e6;
    Object.defineProperty(performance, "memory", {
      configurable: true,
      get: () => ({ usedJSHeapSize: (used += 1e6), totalJSHeapSize: 400e6, jsHeapSizeLimit: 4e9 })
    });
  }

  /* ---- Foundry Hooks (behaviourally faithful to the real one) ---- */
  const Hooks = {
    events: {},
    _ids: {},
    _id: 1,
    on(hook, fn, options = {}) {
      const id = this._id++;
      const entry = { hook, id, fn, once: !!options.once };
      (this.events[hook] ||= []).push(entry);
      this._ids[id] = entry;
      return id;
    },
    once(hook, fn) { return this.on(hook, fn, { once: true }); },
    off(hook, fn) {
      const arr = this.events[hook];
      if (!arr) return;
      const idx = typeof fn === "number"
        ? arr.findIndex((e) => e.id === fn)
        : arr.findIndex((e) => e.fn === fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    callAll(hook, ...args) {
      for (const e of [...(this.events[hook] || [])]) {
        if (e.once) this.off(hook, e.fn);
        e.fn(...args);
      }
      return true;
    },
    call(hook, ...args) {
      for (const e of [...(this.events[hook] || [])]) {
        if (e.once) this.off(hook, e.fn);
        if (e.fn(...args) === false) return false;
      }
      return true;
    }
  };
  globalThis.Hooks = Hooks;

  /* ---- PIXI ---- */
  class Ticker {
    constructor() { this._fns = []; }
    add(fn, ctx, priority) { this._fns.push({ fn, ctx, priority }); return this; }
    addOnce(fn, ctx, priority) { this._fns.push({ fn, ctx, priority, once: true }); return this; }
    remove(fn) { this._fns = this._fns.filter((e) => e.fn !== fn); return this; }
    tick(dt = 1) { for (const e of [...this._fns]) { if (e.once) this.remove(e.fn); e.fn.call(e.ctx, dt); } }
  }
  class DisplayObject {}
  class Container extends DisplayObject {
    constructor() { super(); this.children = []; }
    addChild(...c) { this.children.push(...c); return c[0]; }
  }
  globalThis.PIXI = { VERSION: "7.4.3-harness", Ticker, Container, DisplayObject, utils: { BaseTextureCache: {} } };

  /* ---- libWrapper (behaviourally faithful: WRAPPER receives the chain as arg 0) ---- */
  const registry = new Map(); // target -> [fn]
  const originals = new Map();
  const libWrapper = {
    WRAPPER: "WRAPPER", MIXED: "MIXED", OVERRIDE: "OVERRIDE", LISTENER: "LISTENER",
    register(pkg, target, fn, type = "MIXED") {
      if (!registry.has(target)) registry.set(target, []);
      registry.get(target).push({ pkg, fn, type });
      return registry.get(target).length;
    },
    /** Test helper: build and invoke the dispatch chain for a target. */
    _invoke(target, originalFn, ...args) {
      originals.set(target, originalFn);
      const list = registry.get(target) || [];
      let next = originalFn;
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        const inner = next;
        next = entry.type === "WRAPPER" || entry.type === "MIXED"
          ? function (...a) { return entry.fn.call(this, inner, ...a); }
          : function (...a) { entry.fn.apply(this, a); return inner.apply(this, a); };
      }
      return next(...args);
    },
    _clear() { registry.clear(); }
  };
  globalThis.libWrapper = libWrapper;

  /* ---- Foundry document layer ---- */
  class Document {
    static createDocuments(data) { return Promise.resolve(data); }
    static updateDocuments(data) { return Promise.resolve(data); }
    static deleteDocuments(ids) { return Promise.resolve(ids); }
    createEmbeddedDocuments(n, d) { return Promise.resolve(d); }
    updateEmbeddedDocuments(n, d) { return Promise.resolve(d); }
    deleteEmbeddedDocuments(n, d) { return Promise.resolve(d); }
  }
  globalThis.foundry = {
    abstract: { Document },
    applications: {
      instances: new Map(),
      detached: { windows: new Map() }
    }
  };

  return { Hooks, Ticker, Container, Document, FakeNode, Window, libWrapper, mainDocument };
}
