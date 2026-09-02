/**
 * DMM Performance Checker — Census collectors
 * -------------------------------------------
 * These are *passive* snapshot collectors. Nothing here patches anything; it walks live
 * structures (canvas scene graph, DOM, document flags, settings storage, resource timing)
 * and produces a plain serialisable object.
 *
 * Everything is written defensively: Foundry internals move between generations, so every
 * accessor is optional-chained and every walk is depth/node capped. A profiler that throws
 * during a live session is worse than useless.
 */

export const MODULE_ID = "dmm-performance-checker";

const P = () => globalThis.DMMPC;

/* ---------------------------------------------------------------------------------------- */
/* Utilities                                                                                  */
/* ---------------------------------------------------------------------------------------- */

export function bytes(n) {
  if (!n || !isFinite(n)) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function ms(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`;
  if (n >= 10) return `${n.toFixed(0)} ms`;
  if (n >= 1) return `${n.toFixed(1)} ms`;
  return `${n.toFixed(2)} ms`;
}

/** Yield to the event loop so a full-world scan never freezes a live session. */
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * Resolve a package identifier to the thing that actually owns it.
 *
 * Two vocabularies arrive here and neither is "a module id":
 *   - flag namespaces from the world scan, which are bare (`dnd5e`, `core`, `world`);
 *   - owner ids from stack attribution, which prefix systems (`system:dnd5e`) and collapse
 *     world scripts to `world-script`.
 *
 * Only modules live in `game.modules`, so resolving everything through it labelled the active
 * system, Foundry core and world-level flags as "not installed" — the exact opposite of the
 * truth for the one system every document in the world depends on.
 *
 * Note the client only ever knows a single system, the active one: there is no `game.systems`.
 * A namespace naming some *other* system is therefore genuinely dead weight in this world and
 * is still reported as not installed.
 */
export function resolvePackage(id) {
  const game = globalThis.game;
  const raw = String(id ?? "");

  if (raw === "core" || raw === "") return { id: "core", title: "Foundry Core", installed: true, active: true, kind: "core" };
  if (raw === "unattributed") return { id: raw, title: "Unattributed", installed: false, active: false, kind: "unknown" };
  if (raw === "world" || raw === "world-script") {
    return { id: raw, title: game?.world?.title ? `World: ${game.world.title}` : "World", installed: true, active: true, kind: "world" };
  }

  const sys = game?.system;
  const sysId = raw.startsWith("system:") ? raw.slice(7) : raw;
  if (sys?.id && sysId === sys.id) {
    return { id: raw, title: sys.title || sys.data?.title || sysId, installed: true, active: true, kind: "system" };
  }
  if (raw.startsWith("system:")) return { id: raw, title: sysId, installed: false, active: false, kind: "system" };

  const mod = game?.modules?.get?.(raw);
  return { id: raw, title: mod?.title || raw, installed: !!mod, active: !!mod?.active, kind: "module" };
}

/**
 * Bounded deep-size estimate. Not a real heap measurement — nothing in JS can give you that
 * from inside the page — but it is a solid proxy for "how much stuff is this module holding".
 * Cycle-safe, node-capped, and it reports whether it hit the cap so the number is honest.
 */
export function estimateSize(root, { maxNodes = 200000, maxDepth = 12 } = {}) {
  try {
    return estimateSizeInner(root, maxNodes, maxDepth);
  } catch (e) {
    // A size estimate is never worth breaking the dashboard for.
    return { bytes: 0, nodes: 0, truncated: true, error: String(e?.message || e) };
  }
}

function estimateSizeInner(root, maxNodes, maxDepth) {
  let total = 0;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet();
  const stack = [[root, 0]];

  while (stack.length) {
    if (nodes >= maxNodes) { truncated = true; break; }
    const [v, depth] = stack.pop();
    nodes++;
    const t = typeof v;
    if (v === null || v === undefined) { total += 8; continue; }
    if (t === "boolean") { total += 4; continue; }
    if (t === "number") { total += 8; continue; }
    if (t === "bigint") { total += 16; continue; }
    if (t === "string") { total += 16 + v.length * 2; continue; }
    if (t === "symbol") { total += 16; continue; }
    if (t === "function") { total += 64; continue; }
    if (t !== "object") { total += 8; continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    total += 48;
    if (depth >= maxDepth) { truncated = true; continue; }

    // Typed arrays / buffers are the honest wins — exact byte counts.
    if (ArrayBuffer.isView(v)) { total += v.byteLength; continue; }
    if (v instanceof ArrayBuffer) { total += v.byteLength; continue; }
    // Note: Foundry's `Collection extends Map` overrides Symbol.iterator to yield *values*
    // rather than entries, so `for (const [k, val] of someCollection)` throws. Always go
    // through the explicit .entries() / .values() methods, and never trust that they work.
    if (v instanceof Map) {
      total += v.size * 32;
      try {
        let i = 0;
        for (const e of v.entries()) {
          if (i++ > 5000) { truncated = true; break; }
          stack.push([e[0], depth + 1], [e[1], depth + 1]);
        }
      } catch (e) { truncated = true; }
      continue;
    }
    if (v instanceof Set) {
      total += v.size * 24;
      try {
        let i = 0;
        for (const val of v.values()) { if (i++ > 5000) { truncated = true; break; } stack.push([val, depth + 1]); }
      } catch (e) { truncated = true; }
      continue;
    }
    if (Array.isArray(v)) {
      total += 24 + v.length * 8;
      const lim = Math.min(v.length, 20000);
      if (lim < v.length) truncated = true;
      for (let i = 0; i < lim; i++) stack.push([v[i], depth + 1]);
      continue;
    }
    // Skip DOM and PIXI objects — they are host objects whose JS footprint is not the story,
    // and walking them explodes the graph.
    if (typeof Node !== "undefined" && v instanceof Node) { total += 128; continue; }
    if (globalThis.PIXI && (v instanceof globalThis.PIXI.DisplayObject)) { total += 256; continue; }

    let keys;
    try { keys = Object.keys(v); } catch (e) { continue; }
    total += keys.length * 16;
    const lim = Math.min(keys.length, 5000);
    if (lim < keys.length) truncated = true;
    for (let i = 0; i < lim; i++) {
      total += keys[i].length * 2;
      let val;
      try { val = v[keys[i]]; } catch (e) { continue; }
      stack.push([val, depth + 1]);
    }
  }
  return { bytes: total, nodes, truncated };
}

/** Fast, accurate byte size of anything JSON-serialisable (documents, flags, settings). */
export function jsonSize(v) {
  try {
    const s = JSON.stringify(v);
    return s ? s.length : 0;
  } catch (e) {
    return 0;
  }
}

/* ---------------------------------------------------------------------------------------- */
/* 1. Static asset cost — what each module made the browser download and parse               */
/* ---------------------------------------------------------------------------------------- */

export function resourceCensus() {
  const out = new Map();
  let entries = [];
  try { entries = performance.getEntriesByType("resource") || []; } catch (e) { /* ignore */ }
  const re = /\/(modules|systems|worlds)\/([^/?#]+)\//;
  for (const e of entries) {
    const m = re.exec(e.name || "");
    let id;
    if (m) id = m[1] === "modules" ? m[2] : m[1] === "systems" ? `system:${m[2]}` : "world-script";
    else id = "core";
    let r = out.get(id);
    if (!r) out.set(id, (r = { owner: id, count: 0, bytes: 0, decoded: 0, duration: 0, js: 0, css: 0, img: 0, font: 0, biggest: null }));
    r.count++;
    const size = e.transferSize || e.encodedBodySize || 0;
    const decoded = e.decodedBodySize || size;
    r.bytes += size;
    r.decoded += decoded;
    r.duration += e.duration || 0;
    const type = /\.m?js(\?|$)/.test(e.name) ? "js"
      : /\.css(\?|$)/.test(e.name) ? "css"
        : /\.(webp|png|jpe?g|gif|svg|webm|mp4|ogg)(\?|$)/i.test(e.name) ? "img"
          : /\.(woff2?|ttf|otf)(\?|$)/i.test(e.name) ? "font" : "other";
    if (r[type] !== undefined) r[type] += decoded;
    if (!r.biggest || decoded > r.biggest.bytes) r.biggest = { name: shortName(e.name), bytes: decoded, ms: e.duration || 0 };
  }
  return [...out.values()].sort((a, b) => b.decoded - a.decoded);
}

function shortName(u) {
  try { return String(u).split("?")[0].split("/").slice(-2).join("/"); } catch (e) { return String(u); }
}

/* ---------------------------------------------------------------------------------------- */
/* 2. Canvas census                                                                           */
/* ---------------------------------------------------------------------------------------- */

export function canvasCensus() {
  const out = {
    available: false,
    pixi: globalThis.PIXI?.VERSION || "?",
    renderer: null,
    totalObjects: 0,
    maxDepth: 0,
    byClass: [],
    byOwner: [],
    filters: [],
    filterCount: 0,
    filteredObjects: 0,
    textures: { count: 0, bytes: 0, biggest: [] },
    layers: [],
    scene: null,
    tickerListeners: 0,
    truncated: false
  };
  const canvas = globalThis.canvas;
  if (!canvas?.ready || !canvas.stage) return out;
  out.available = true;

  const r = canvas.app?.renderer;
  if (r) {
    out.renderer = {
      type: r.type === 1 ? "WebGL" : String(r.type ?? "?"),
      width: r.width, height: r.height,
      resolution: r.resolution,
      maxTextures: r.gl?.getParameter?.(r.gl.MAX_TEXTURE_IMAGE_UNITS) ?? null,
      contextLost: !!r.gl?.isContextLost?.()
    };
  }

  // --- scene graph walk -------------------------------------------------------------------
  const byClass = new Map();
  const byOwner = new Map();
  const filters = new Map();
  let count = 0, maxDepth = 0, filtered = 0, filterTotal = 0;
  const NODE_CAP = 250000;

  const walk = (obj, depth, ownerHint) => {
    if (!obj || count >= NODE_CAP) { if (count >= NODE_CAP) out.truncated = true; return; }
    count++;
    if (depth > maxDepth) maxDepth = depth;
    const cls = obj.constructor?.name || "Object";
    byClass.set(cls, (byClass.get(cls) || 0) + 1);
    const own = obj.__dmmOwner || ownerHint || null;
    if (own) byOwner.set(own, (byOwner.get(own) || 0) + 1);
    const f = obj.filters;
    if (f && f.length) {
      filtered++;
      filterTotal += f.length;
      for (const fl of f) {
        const fn = fl?.constructor?.name || "Filter";
        const rec = filters.get(fn) || { name: fn, count: 0, enabled: 0, on: new Set() };
        rec.count++;
        if (fl?.enabled !== false) rec.enabled++;
        rec.on.add(cls);
        filters.set(fn, rec);
      }
    }
    const kids = obj.children;
    if (kids && kids.length) for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1, own);
  };
  try { walk(canvas.stage, 0, null); } catch (e) { out.error = String(e?.message || e); }

  out.totalObjects = count;
  out.maxDepth = maxDepth;
  out.filteredObjects = filtered;
  out.filterCount = filterTotal;
  out.byClass = [...byClass.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 40);
  out.byOwner = [...byOwner.entries()].map(([owner, n]) => ({ owner, n })).sort((a, b) => b.n - a.n);
  out.filters = [...filters.values()].map((f) => ({ name: f.name, count: f.count, enabled: f.enabled, on: [...f.on].slice(0, 4).join(", ") })).sort((a, b) => b.count - a.count);

  // --- texture memory ---------------------------------------------------------------------
  const cache = globalThis.PIXI?.utils?.BaseTextureCache || globalThis.PIXI?.BaseTextureCache;
  if (cache) {
    const list = [];
    let total = 0, n = 0;
    for (const key of Object.keys(cache)) {
      const bt = cache[key];
      if (!bt) continue;
      const w = bt.realWidth || bt.width || 0;
      const h = bt.realHeight || bt.height || 0;
      const mip = bt.mipmap ? 1.33 : 1;
      const b = Math.round(w * h * 4 * mip);
      total += b; n++;
      list.push({ key: shortName(key), w, h, bytes: b });
    }
    out.textures.count = n;
    out.textures.bytes = total;
    out.textures.biggest = list.sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  }

  // --- per-layer object counts -------------------------------------------------------------
  try {
    const layers = canvas.layers || [];
    for (const l of layers) {
      const name = l?.constructor?.name || l?.name || "?";
      let n = 0;
      const c = (o) => { if (!o) return; n++; const k = o.children; if (k) for (const x of k) c(x); };
      c(l);
      out.layers.push({
        name,
        objects: n,
        placeables: l?.placeables?.length ?? null,
        visible: l?.visible !== false,
        interactive: !!l?.interactiveChildren
      });
    }
    out.layers.sort((a, b) => b.objects - a.objects);
  } catch (e) { /* ignore */ }

  // --- scene content ------------------------------------------------------------------------
  const scene = globalThis.game?.scenes?.current || canvas.scene;
  if (scene) {
    const embedded = {};
    try {
      const names = Object.keys(scene.constructor?.metadata?.embedded || {});
      for (const nm of names) {
        const coll = scene.getEmbeddedCollection?.(nm);
        if (coll) embedded[nm] = coll.size ?? coll.length ?? 0;
      }
    } catch (e) { /* ignore */ }
    out.scene = {
      name: scene.name,
      id: scene.id,
      dims: `${scene.width}×${scene.height}`,
      padding: scene.padding,
      grid: scene.grid?.size,
      tokenVision: scene.tokenVision,
      fogExploration: scene.fog?.exploration ?? scene.fogExploration,
      globalLight: scene.environment?.globalLight?.enabled ?? scene.globalLight,
      embedded,
      sourceBytes: jsonSize(scene._source ?? scene.toObject?.()),
      levels: scene.levels?.length ?? scene.levels?.size ?? null
    };
  }

  try {
    let t = canvas.app?.ticker?._head, n = 0;
    while (t) { n++; t = t.next; if (n > 5000) break; }
    out.tickerListeners = n;
  } catch (e) { /* ignore */ }

  return out;
}

/* ---------------------------------------------------------------------------------------- */
/* 3. DOM census                                                                              */
/* ---------------------------------------------------------------------------------------- */

/**
 * Foundry v14 can render an ApplicationV2 into a genuinely separate browser window
 * (`foundry.applications.detached`). Those nodes are not in the main document, so anything
 * counted with `document.*` silently omits them and a popped-out sheet reads as a shrinking
 * DOM. Return every document we should be counting, main window first.
 */
export function allDocuments() {
  const docs = [document];
  try {
    const wins = globalThis.foundry?.applications?.detached?.windows;
    if (wins) {
      for (const { window: win } of wins.values()) {
        const d = win?.document;
        if (d && d !== document && !win.closed) docs.push(d);
      }
    }
  } catch (e) { /* a closed or cross-origin window: skip it */ }
  return docs;
}

export function domCensus() {
  const out = {
    total: 0, depth: 0,
    byRegion: [],
    chat: { messages: 0, domMessages: 0, nodesPerMessage: 0, nodes: 0 },
    apps: { open: 0, list: [] },
    heavySubtrees: [],
    styleSheets: 0, cssRules: 0,
    images: 0, videos: 0, canvases: 0,
    inlineStyles: 0,
    // v14 pop-out windows, reported separately so the main-window figures stay comparable
    // across a session in which something was detached.
    detachedWindows: []
  };
  try {
    const docs = allDocuments();
    const count = (sel) => docs.reduce((n, d) => n + d.querySelectorAll(sel).length, 0);
    const all = document.getElementsByTagName("*");
    out.total = all.length;

    for (let i = 1; i < docs.length; i++) {
      const d = docs[i];
      out.detachedWindows.push({
        id: d.defaultView?.id || `window-${i}`,
        nodes: d.getElementsByTagName("*").length,
        apps: [...(globalThis.foundry?.applications?.detached?.windows?.values() || [])]
          .find((w) => w.window?.document === d)?.applications?.size ?? 0
      });
      out.total += out.detachedWindows[i - 1].nodes;
    }
    let d = 0;
    const measure = (el, depth) => {
      if (depth > d) d = depth;
      const k = el.children;
      for (let i = 0; i < k.length; i++) measure(k[i], depth + 1);
    };
    measure(document.body, 0);
    out.depth = d;

    out.images = count("img");
    out.videos = count("video");
    out.canvases = count("canvas");
    out.inlineStyles = count("[style]");
    out.styleSheets = document.styleSheets.length;
    let rules = 0;
    for (const ss of document.styleSheets) {
      try { rules += ss.cssRules?.length || 0; } catch (e) { /* cross-origin */ }
    }
    out.cssRules = rules;

    // Top-level regions of the UI, so you can see where the weight actually is.
    const regions = ["#interface", "#ui-left", "#ui-right", "#ui-top", "#ui-bottom", "#sidebar",
      ".chat-log", "#players", "#hotbar", "#controls", "#navigation",
      "#tooltip", "#board", "#pause", "#notifications"];
    for (const sel of regions) {
      const el = document.querySelector(sel);
      if (!el) continue;
      out.byRegion.push({ sel, nodes: el.getElementsByTagName("*").length + 1 });
    }
    out.byRegion.sort((a, b) => b.nodes - a.nodes);

    // Chat log is the classic long-session DOM leak.
    //
    // v14 renders the same messages twice: once in the sidebar tab and again in the floating
    // chat-notifications panel, both under `.chat-log`. Counting every `.chat-log` doubled the
    // figure, which matters because this is a leak indicator. Take the largest single log —
    // the sidebar — rather than the union.
    const logs = [...document.querySelectorAll(".chat-log")];
    const log = logs.sort((a, b) => b.childElementCount - a.childElementCount)[0] || null;
    const msgs = log ? log.querySelectorAll(".chat-message") : [];
    out.chat.domMessages = msgs.length;
    out.chat.messages = globalThis.game?.messages?.size || 0;
    out.chat.nodes = log ? log.getElementsByTagName("*").length : 0;
    out.chat.nodesPerMessage = msgs.length ? Math.round(out.chat.nodes / msgs.length) : 0;
    out.chat.logs = logs.length;

    // Open applications, and any that are rendered but orphaned from the document.
    //
    // `document.contains(el)` was the wrong test from v14 onward: an application popped out
    // into its own browser window lives in a different document entirely, so a perfectly
    // healthy detached sheet was reported as an orphaned instance — the very signal this
    // table uses to flag a leak. `isConnected` is relative to the node's own document and
    // answers the question actually being asked.
    const insts = globalThis.foundry?.applications?.instances;
    const detachedWins = globalThis.foundry?.applications?.detached?.windows;
    const list = [];
    if (insts) {
      for (const [id, app] of insts) {
        const el = app?.element;
        const attached = el ? el.isConnected === true : false;
        const ownerDoc = el?.ownerDocument;
        let host = null;
        if (ownerDoc && ownerDoc !== document && detachedWins) {
          for (const [winId, desc] of detachedWins) {
            if (desc?.window?.document === ownerDoc) { host = winId; break; }
          }
          host ??= "detached window";
        }
        list.push({
          id,
          cls: app?.constructor?.name || "?",
          nodes: el ? el.getElementsByTagName("*").length : 0,
          attached,
          // "Orphaned" now means what it says: rendered, but connected to no document at all.
          orphaned: !!el && !attached,
          poppedOut: host
        });
      }
    }
    for (const [id, app] of Object.entries(globalThis.ui?.windows || {})) {
      const el = app?.element?.[0] || app?.element;
      list.push({ id: `v1:${id}`, cls: app?.constructor?.name || "?", nodes: el?.getElementsByTagName ? el.getElementsByTagName("*").length : 0, attached: true, orphaned: false, poppedOut: null });
    }
    out.apps.open = list.length;
    out.apps.list = list.sort((a, b) => b.nodes - a.nodes).slice(0, 30);

    // Heaviest arbitrary subtrees (catches a module quietly building a 40k-node panel).
    const heavy = [];
    const scan = (el, depth) => {
      if (depth > 6) return;
      const n = el.getElementsByTagName("*").length;
      if (n > 400) {
        heavy.push({ tag: el.tagName.toLowerCase(), id: el.id || "", cls: (typeof el.className === "string" ? el.className : "").slice(0, 60), nodes: n });
        for (const c of el.children) scan(c, depth + 1);
      }
    };
    scan(document.body, 0);
    out.heavySubtrees = heavy.sort((a, b) => b.nodes - a.nodes).slice(0, 20);
  } catch (e) {
    out.error = String(e?.message || e);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------- */
/* 4. Data census — flag bloat, settings bloat, compendium weight                             */
/* ---------------------------------------------------------------------------------------- */

/**
 * Scans every world document (and its embedded documents) for module flags and measures how
 * many bytes each module namespace is adding to your world data. Flag bloat is the number one
 * cause of "the world takes 90 seconds to load" and "switching scenes hitches".
 *
 * Runs chunked with yields so it will not freeze a live session.
 */
export async function dataCensus(onProgress = () => {}) {
  const game = globalThis.game;
  const out = {
    flags: [],            // {namespace, bytes, docs, biggest:{name,type,bytes}}
    documents: [],        // {type, count, bytes}
    settings: [],         // {namespace, worldBytes, clientBytes, keys}
    localStorage: { totalBytes: 0, byNamespace: [] },
    packs: [],
    totals: { docBytes: 0, flagBytes: 0, docs: 0, embedded: 0 },
    scanned: 0,
    error: null
  };
  if (!game?.ready) { out.error = "Game not ready."; return out; }

  const flagAgg = new Map();
  const addFlags = (source, docName, docType) => {
    const f = source?.flags;
    if (!f) return;
    for (const ns of Object.keys(f)) {
      if (ns === "core" || ns === "exportSource") continue;
      const b = jsonSize(f[ns]);
      if (!b) continue;
      let r = flagAgg.get(ns);
      if (!r) flagAgg.set(ns, (r = { namespace: ns, bytes: 0, docs: 0, biggest: null, byType: new Map() }));
      r.bytes += b;
      r.docs++;
      r.byType.set(docType, (r.byType.get(docType) || 0) + b);
      if (!r.biggest || b > r.biggest.bytes) r.biggest = { name: docName, type: docType, bytes: b };
    }
  };

  const collections = [
    ["Actor", game.actors], ["Item", game.items], ["JournalEntry", game.journal],
    ["RollTable", game.tables], ["Macro", game.macros], ["Playlist", game.playlists],
    ["Scene", game.scenes], ["User", game.users], ["Combat", game.combats],
    ["Cards", game.cards], ["Folder", game.folders], ["ChatMessage", game.messages]
  ];

  let scanned = 0;
  for (const [name, coll] of collections) {
    if (!coll) continue;
    let typeBytes = 0, n = 0;
    let i = 0;
    for (const doc of coll) {
      const src = doc?._source ?? doc;
      const b = jsonSize(src);
      typeBytes += b;
      n++;
      addFlags(src, doc?.name || doc?.id || "?", name);

      // Embedded documents (tokens carry the worst flag payloads in practice).
      try {
        const embeddedNames = Object.keys(doc?.constructor?.metadata?.embedded || {});
        for (const en of embeddedNames) {
          const ec = doc.getEmbeddedCollection?.(en);
          if (!ec) continue;
          for (const ed of ec) {
            out.totals.embedded++;
            addFlags(ed?._source ?? ed, `${doc?.name || "?"} › ${ed?.name || ed?.id || en}`, `${name}.${en}`);
          }
        }
      } catch (e) { /* ignore */ }

      // Prototype token flags live outside the embedded collections.
      if (name === "Actor") addFlags(src?.prototypeToken, `${doc?.name} (prototype)`, "PrototypeToken");

      scanned++;
      if ((++i & 63) === 0) { onProgress(`${name}: ${i}/${coll.size ?? "?"}`); await yieldToUI(); }
    }
    out.documents.push({ type: name, count: n, bytes: typeBytes });
    out.totals.docBytes += typeBytes;
    out.totals.docs += n;
    onProgress(`${name} done (${n})`);
    await yieldToUI();
  }
  out.scanned = scanned;
  out.documents.sort((a, b) => b.bytes - a.bytes);

  out.flags = [...flagAgg.values()].map((r) => {
    // A flag namespace is not necessarily a module: the active system, core and the world
    // itself all write flags, and none of them are in `game.modules`.
    const pkg = resolvePackage(r.namespace);
    return {
      namespace: r.namespace,
      bytes: r.bytes,
      docs: r.docs,
      biggest: r.biggest,
      byType: [...r.byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, b]) => `${t} ${bytes(b)}`).join(", "),
      owner: pkg.title,
      kind: pkg.kind,
      installed: pkg.installed,
      active: pkg.active
    };
  }).sort((a, b) => b.bytes - a.bytes);
  out.totals.flagBytes = out.flags.reduce((a, b) => a + b.bytes, 0);

  // --- settings ---------------------------------------------------------------------------
  const settingAgg = new Map();
  const bump = (ns, key, worldB, clientB) => {
    let r = settingAgg.get(ns);
    if (!r) settingAgg.set(ns, (r = { namespace: ns, worldBytes: 0, clientBytes: 0, keys: 0, biggest: null }));
    r.worldBytes += worldB;
    r.clientBytes += clientB;
    r.keys++;
    const tot = worldB + clientB;
    if (!r.biggest || tot > r.biggest.bytes) r.biggest = { key, bytes: tot };
  };
  try {
    // v14's storage map has three scopes but only two stores: `user` is set to the very same
    // WorldSettings object as `world` (client-settings.mjs sets one from the other), so
    // iterating naively counted every world setting twice. Dedupe by store identity.
    const seenStores = new Set();
    for (const [scope, store] of game.settings.storage) {
      if (!store || seenStores.has(store)) continue;
      seenStores.add(store);
      if (store?.contents || store?.values) {
        // World/user scoped: a collection of Setting documents.
        const it = store.contents ?? [...store.values()];
        for (const s of it) {
          const key = s?.key ?? "";
          const ns = key.split(".")[0] || "?";
          bump(ns, key, jsonSize(s?.value ?? s?._source?.value), 0);
        }
      } else if (typeof store?.length === "number" && typeof store?.key === "function") {
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          const v = store.getItem(k) || "";
          const ns = String(k).split(".")[0] || "?";
          bump(ns, k, 0, (k.length + v.length) * 2);
        }
      }
      void scope;
    }
  } catch (e) { out.error = `settings: ${e?.message || e}`; }
  out.settings = [...settingAgg.values()].sort((a, b) => (b.worldBytes + b.clientBytes) - (a.worldBytes + a.clientBytes));

  // --- raw localStorage (client settings + whatever modules stash there) --------------------
  try {
    const nsAgg = new Map();
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || "";
      const b = (k.length + v.length) * 2;
      total += b;
      const ns = String(k).split(".")[0] || "?";
      nsAgg.set(ns, (nsAgg.get(ns) || 0) + b);
    }
    out.localStorage.totalBytes = total;
    out.localStorage.byNamespace = [...nsAgg.entries()].map(([namespace, b]) => ({ namespace, bytes: b })).sort((a, b) => b.bytes - a.bytes);
  } catch (e) { /* ignore */ }

  // --- compendium packs --------------------------------------------------------------------
  try {
    for (const pack of game.packs) {
      const idx = pack.index;
      out.packs.push({
        id: pack.collection,
        label: pack.metadata?.label,
        owner: pack.metadata?.packageName || pack.metadata?.package || "?",
        type: pack.documentName,
        indexed: idx?.size ?? 0,
        indexBytes: idx ? jsonSize([...idx.values()].slice(0, 500)) * ((idx.size || 1) / Math.min(idx.size || 1, 500)) : 0,
        loaded: !!pack._initialized || (pack.contents?.length > 0)
      });
    }
    out.packs.sort((a, b) => b.indexed - a.indexed);
  } catch (e) { /* ignore */ }

  return out;
}

/* ---------------------------------------------------------------------------------------- */
/* 5. Memory census — retained structures we can actually see                                 */
/* ---------------------------------------------------------------------------------------- */

export function memoryCensus() {
  const game = globalThis.game;
  const out = {
    heap: null,
    modules: [],
    newGlobals: [],
    probeSelf: null
  };
  const mem = performance.memory;
  if (mem) {
    out.heap = {
      used: mem.usedJSHeapSize,
      total: mem.totalJSHeapSize,
      limit: mem.jsHeapSizeLimit,
      pctOfLimit: (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100
    };
  }

  // Per-module API surface. Most modules park their caches on module.api / module.instance /
  // a global. This is where index-building modules (search, compendium browsers) hide.
  if (game?.modules) {
    for (const mod of game.modules) {
      if (!mod.active) continue;
      const roots = [];
      if (mod.api) roots.push(["api", mod.api]);
      if (mod.instance) roots.push(["instance", mod.instance]);
      if (mod.socket) roots.push(["socket", mod.socket]);
      if (!roots.length) continue;
      let total = 0, truncated = false, nodes = 0;
      const parts = [];
      for (const [label, obj] of roots) {
        const r = estimateSize(obj, { maxNodes: 120000, maxDepth: 10 });
        total += r.bytes; nodes += r.nodes; truncated ||= r.truncated;
        parts.push(`${label} ${bytes(r.bytes)}`);
      }
      out.modules.push({ id: mod.id, title: mod.title, bytes: total, nodes, truncated, parts: parts.join(", ") });
    }
    out.modules.sort((a, b) => b.bytes - a.bytes);
  }

  // Globals created after the probe loaded — i.e. by packages.
  const base = P()?.baselineGlobals;
  if (base) {
    const skip = new Set(["DMMPC", "webkitStorageInfo"]);
    for (const k of Object.getOwnPropertyNames(globalThis)) {
      if (base.has(k) || skip.has(k)) continue;
      let v;
      try { v = globalThis[k]; } catch (e) { continue; }
      if (v === undefined || v === null) continue;
      const t = typeof v;
      if (t !== "object" && t !== "function") continue;
      const r = estimateSize(v, { maxNodes: 60000, maxDepth: 8 });
      out.newGlobals.push({ key: k, type: t, bytes: r.bytes, truncated: r.truncated, guess: guessOwner(k) });
    }
    out.newGlobals.sort((a, b) => b.bytes - a.bytes);
  }

  // How much are we ourselves holding?
  const p = P();
  if (p) {
    const r = estimateSize({
      owners: p.owners, hooks: p.hooks, listeners: p.listeners, ticker: p.ticker,
      net: p.net, db: p.db, spans: p.spans.buf, samples: p.samples.buf, frames: p.frames.buf
    }, { maxNodes: 300000, maxDepth: 8 });
    out.probeSelf = {
      bytes: r.bytes,
      overheadPct: p.overhead.stackMs / Math.max(1, performance.now() - p.p0) * 100,
      stackCaptures: p.overhead.stackCaptures,
      degraded: p.overhead.degraded
    };
  }
  return out;
}

function guessOwner(key) {
  const game = globalThis.game;
  if (!game?.modules) return "";
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const m of game.modules) {
    if (!m.active) continue;
    const id = m.id.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!id) continue;
    if (k.includes(id) || id.includes(k)) return m.id;
    const t = (m.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t && (k === t || t.includes(k))) return m.id;
  }
  return "";
}

/* ---------------------------------------------------------------------------------------- */
/* 6. Idle churn test — the single most diagnostic thing you can run mid-session              */
/* ---------------------------------------------------------------------------------------- */

/**
 * Sit still for `durationMs` and measure everything that happens anyway. In a healthy world
 * with nothing selected and no animation, the answer should be close to nothing. Anything a
 * module does here, it is doing continuously, all session, forever.
 */
export async function idleChurnTest(durationMs = 6000, onTick = () => {}) {
  const p = P();
  if (!p) return null;
  const snap = () => ({
    hookCalls: new Map([...p.hooks].map(([k, v]) => [k, v.calls])),
    listeners: new Map([...p.listeners].map(([k, v]) => [k, v.calls])),
    ticker: new Map([...p.ticker].map(([k, v]) => [k, v.calls])),
    owners: new Map([...p.owners].map(([k, v]) => [k, {
      hookCalls: v.hookCalls, hookTotal: v.hookTotal, timerCalls: v.timerCalls, timerTotal: v.timerTotal,
      listenerCalls: v.listenerCalls, listenerTotal: v.listenerTotal, tickerCalls: v.tickerCalls,
      tickerTotal: v.tickerTotal, domOps: v.domOps, dbDocs: v.dbDocs, netRequests: v.netRequests,
      storageWrites: v.storageWrites
    }])),
    heap: performance.memory?.usedJSHeapSize || 0,
    frames: p.global.frames,
    t: performance.now()
  });

  const a = snap();
  const step = 250;
  for (let elapsed = 0; elapsed < durationMs; elapsed += step) {
    await new Promise((r) => setTimeout(r, step));
    onTick(Math.min(100, Math.round((elapsed / durationMs) * 100)));
  }
  const b = snap();
  const secs = (b.t - a.t) / 1000;

  const owners = [];
  for (const [id, after] of b.owners) {
    const before = a.owners.get(id) || {};
    const d = {};
    let any = false;
    for (const k of Object.keys(after)) {
      d[k] = (after[k] || 0) - (before[k] || 0);
      if (d[k] > 0) any = true;
    }
    if (!any) continue;
    const cpuMs = (d.hookTotal || 0) + (d.timerTotal || 0) + (d.listenerTotal || 0) + (d.tickerTotal || 0);
    owners.push({
      owner: id,
      cpuMs,
      cpuPct: (cpuMs / (secs * 1000)) * 100,
      callsPerSec: ((d.hookCalls || 0) + (d.timerCalls || 0) + (d.listenerCalls || 0) + (d.tickerCalls || 0)) / secs,
      domOpsPerSec: (d.domOps || 0) / secs,
      dbPerSec: (d.dbDocs || 0) / secs,
      netPerSec: (d.netRequests || 0) / secs,
      storagePerSec: (d.storageWrites || 0) / secs,
      detail: d
    });
  }
  owners.sort((x, y) => y.cpuMs - x.cpuMs);

  const hooks = [];
  for (const [k, calls] of b.hookCalls) {
    const d = calls - (a.hookCalls.get(k) || 0);
    if (d > 0) {
      const [hook, ownr] = k.split(" ");
      hooks.push({ hook, owner: ownr, perSec: d / secs });
    }
  }
  hooks.sort((x, y) => y.perSec - x.perSec);

  return {
    seconds: secs,
    fps: (b.frames - a.frames) / secs,
    heapDelta: b.heap - a.heap,
    heapPerMin: ((b.heap - a.heap) / secs) * 60,
    owners,
    hooks: hooks.slice(0, 25)
  };
}
