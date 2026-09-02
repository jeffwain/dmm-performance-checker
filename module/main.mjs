/**
 * DMM Performance Checker — entry point
 * -------------------------------------
 * Registers the settings menu button, keybinding, and a scene-control toggle, and wires the
 * probe to things that only exist once the game is up (socket, canvas ready markers).
 */

import { MODULE_ID } from "./census.mjs";
import { PerformanceDashboard } from "./dashboard.mjs";

const P = () => globalThis.DMMPC;

/** Thin ApplicationV2 shim so `registerMenu` can open the dashboard as a singleton. */
class DashboardLauncher extends foundry.applications.api.ApplicationV2 {
  constructor(...args) {
    super(...args);
    // Never actually render; hand off to the singleton and dispose of ourselves.
    queueMicrotask(() => {
      openDashboard();
      this.close?.().catch(() => {});
    });
  }
  async _renderHTML() { return ""; }
  _replaceHTML() {}
  async render() { openDashboard(); return this; }
}

let _dashboard = null;
export function openDashboard() {
  if (!P()) {
    ui.notifications?.error("DMM Performance Checker: the probe script did not load. Check the console.");
    return null;
  }
  if (!_dashboard) _dashboard = new PerformanceDashboard();
  if (_dashboard.rendered) _dashboard.bringToFront?.();
  else _dashboard.render({ force: true });
  return _dashboard;
}

/* ---------------------------------------------------------------------------------------- */

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "dashboard", {
    name: "DMM Performance Checker",
    label: "Open Performance Dashboard",
    hint: "Per-module CPU, frame, memory, DOM, canvas and world-data forensics, with live module muting.",
    icon: "fa-solid fa-gauge-high",
    type: DashboardLauncher,
    restricted: false
  });

  game.settings.register(MODULE_ID, "showSceneControl", {
    name: "Show scene control button",
    hint: "Adds a gauge button to the token scene controls for one-click access.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false,
    // SceneControls only calls its `getSceneControlButtons` hook on a first or reset render
    // (scene-controls.mjs: `if (options.reset || options.isFirstRender)`), so without this the
    // setting claimed to apply immediately and in fact needed a reload.
    onChange: () => { try { ui.controls?.render({ reset: true }); } catch (e) { /* pre-ready */ } }
  });

  game.settings.register(MODULE_ID, "autoOpen", {
    name: "Open dashboard automatically at startup",
    hint: "Useful when you are actively hunting a problem across a whole session.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.keybindings.register(MODULE_ID, "open", {
    name: "Open Performance Dashboard",
    editable: [{ key: "KeyP", modifiers: ["Control", "Shift"] }],
    onDown: () => { openDashboard(); return true; },
    restricted: false
  });

  // Expose a console API — the dashboard is not always the fastest way to get an answer.
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      open: openDashboard,
      probe: () => P(),
      mute: (id) => P().mute(id),
      unmute: (id) => P().unmute(id),
      unmuteAll: () => P().unmuteAll(),
      reset: () => P().resetCounters(),
      /** Quick console ranking without opening the UI. */
      async top(n = 15) {
        const { scorecard } = await import("./analysis.mjs");
        const { resourceCensus, canvasCensus } = await import("./census.mjs");
        const rows = scorecard({ resources: resourceCensus(), canvas: canvasCensus() });
        console.table(rows.slice(0, n).map((r) => ({
          module: r.id, impact: r.score, "cpu%": +r.cpuPct.toFixed(2),
          "ms/frame": +r.msPerFrame.toFixed(3), hookCalls: r.hookCalls,
          intervals: r.liveIntervals, domOps: r.domOps, errors: r.errors
        })));
        return rows;
      },
      /** Console equivalent of the retention test, for when you'd rather not use the UI. */
      listenerBaseline: () => P().markListenerBaseline(),
      listenerDelta(top = 20) {
        const d = P().listenerDelta();
        if (!d) { console.warn("No baseline marked. Call api.listenerBaseline() first."); return null; }
        console.log(`Net attached change: ${d.totalAttachedDelta >= 0 ? "+" : ""}${d.totalAttachedDelta} over ${(d.sinceMs / 1000).toFixed(0)}s`);
        console.table(d.rows.slice(0, top).map((r) => ({
          package: r.owner, event: r.type, added: r.regsDelta,
          stillAttached: r.attachedDelta,
          retained: `${(r.retainedRatio * 100).toFixed(0)}%`,
          attachedTo: (r.attachedBy || []).map(([l, n]) => `${l}×${n}`).join(", ")
        })));
        return d;
      },
      async idle(sec = 6) {
        const { idleChurnTest } = await import("./census.mjs");
        const r = await idleChurnTest(sec * 1000);
        console.table(r.owners.map((o) => ({
          module: o.owner, "cpu%": +o.cpuPct.toFixed(2), "calls/s": Math.round(o.callsPerSec),
          "dom/s": Math.round(o.domOpsPerSec), "db/s": +o.dbPerSec.toFixed(1)
        })));
        return r;
      }
    };
  }
});

Hooks.once("ready", () => {
  const p = P();
  if (!p) {
    console.error(`${MODULE_ID} | probe not installed — instrumentation unavailable.`);
    ui.notifications?.error("DMM Performance Checker: probe script failed to load.");
    return;
  }
  p.ready = true;

  // Socket instrumentation can only attach once game.socket exists.
  try { p.attachSocket?.(game.socket); } catch (e) { console.warn(`${MODULE_ID} | socket probe`, e); }

  // Record how expensive world startup was, per module, before anything else muddies the data.
  const startup = [];
  for (const [key, rec] of p.hooks) {
    const [hook] = key.split(" ");
    if (["init", "setup", "ready", "i18nInit", "canvasReady", "canvasInit"].includes(hook) && rec.total > 1) {
      startup.push({ hook, owner: rec.owner, ms: +rec.total.toFixed(1) });
    }
  }
  startup.sort((a, b) => b.ms - a.ms);
  p.startupCost = startup;
  if (startup.length) {
    console.groupCollapsed(`${MODULE_ID} | startup cost by module (top ${Math.min(12, startup.length)})`);
    console.table(startup.slice(0, 12));
    console.groupEnd();
  }

  if (game.settings.get(MODULE_ID, "autoOpen")) openDashboard();

  if (!p.early) {
    console.warn(`${MODULE_ID} | ${p.preExisting} hook callbacks were registered before the probe attached. ` +
      `Attribution for those is incomplete. This happens when another package's classic script sorts before ours.`);
  }
});

/* Scene control button — v13/v14 use a record keyed by control name. */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.settings?.get?.(MODULE_ID, "showSceneControl")) return;
  const tool = {
    name: MODULE_ID,
    title: "Performance Dashboard",
    icon: "fa-solid fa-gauge-high",
    button: true,
    visible: true,
    order: 99,
    onChange: () => openDashboard(),
    onClick: () => openDashboard()
  };
  try {
    if (Array.isArray(controls)) {
      const tokens = controls.find((c) => c.name === "token" || c.name === "tokens");
      if (tokens?.tools) {
        if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
        else tokens.tools[MODULE_ID] = tool;
      }
    } else if (controls && typeof controls === "object") {
      const tokens = controls.tokens ?? controls.token;
      if (tokens?.tools) tokens.tools[MODULE_ID] = tool;
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | could not add scene control`, e);
  }
});
