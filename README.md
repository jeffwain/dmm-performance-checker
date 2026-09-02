# DMM Performance Checker

Per-module performance forensics tool for Foundry VTT v13/v14. Yes, this is built \[entirely\] by
AI, though I have tested it and verified that it works. Is it going to be 100% perfect? No. Will it
point you in the right direction? Absolutely. Has it helped pinpoint issues in specific modules 
so that I can dig deeper and make fixes? Yes, yes it has.

Other performance tools tell you *that* things are slow, but I wanted one to tell me which 
module is doing it and where. It checks events like `Hooks.on`, `setTimeout`, `addEventListener`, 
`PIXI.Ticker.add`, `fetch`, `libWrapper.register` and the document write path before any other 
package loads, and then tracks every call back to the source package.

It also lets you mute a module in real-time, blocking callbacks instantly with no reload or 
logging back in to make testing a suspicion module take twenty seconds instead of thirty minutes.

OK, that all said, from here on be AI dragons. - hightouch

---

## Install

Copy the whole folder to `<FoundryUserData>/Data/modules/dmm-performance-checker/`, then enable
it in Module Management.

Open it from **Configure Settings → Module Settings → Open Performance Dashboard**, from the
gauge button in the token scene controls, or with **Ctrl+Shift+P**.

---

## Why it can attribute cost, and where it can't

`scripts/dmm-probe.js` is declared in `module.json` under `"scripts"`, not `"esmodules"`, and
the module declares `"library": true`. Both matter, and the reason changed in v14.

Foundry v14 serves every package script with `defer`
(`templates/views/layouts/main.hbs`: `{{#if this.isModule}}type="module"{{else}}defer{{/if}}`).
Deferred classic scripts and module scripts share one queue and run in **document order**, so
the old rule of thumb — "classic scripts are non-deferred and therefore beat every ESModule" —
no longer holds. What decides the order now is the priority table in the server's
`_getStaticContent`:

| Priority | What |
|---:|---|
| 0–1 | core view scripts and modules |
| 2 | `vendor.mjs`, `foundry.mjs` |
| **3** | **`library: true` module `scripts`  ← the probe** |
| 4 | `library: true` module `esmodules` |
| 5–6 | the game system's `scripts`, then `esmodules` |
| 7–8 | ordinary module `scripts`, then `esmodules` |
| 9–10 | world `scripts`, then `esmodules` |

Without the `library` flag the probe loads at priority 7 — after libWrapper, socketlib, and the
entire game system. In a dnd5e world that silently surrendered every hook the system registers
at module scope (there are around thirty), including hot ones like `renderChatMessage`. They
were registered before the probe owned `Hooks.on`, so they are neither timed nor attributed, and
their cost quietly becomes core's. The `library` flag moves the probe to priority 3, which is
the earliest slot any package can occupy.

**The residual blind spot:** core itself (priority 0–2) always loads first, so core's own
listeners and timers are not attributed — that is by design and not interesting. Among packages,
another `library: true` module whose id sorts before `dmm-performance-checker` will execute
first; if it registers hooks in a classic script, those registrations are invisible.

The dashboard reports this honestly rather than assuming the best case. The Overview tab shows a
finding with the exact count of pre-existing callbacks, `globalThis.DMMPC.early` is `false`
whenever any exist, and anything that cannot be traced lands in an explicit `unattributed` row
instead of being spread around. **Check `DMMPC.preExisting` once after a version upgrade** — it
is the one number that tells you whether load order still holds.

### Browser matters more than you'd expect

Several of the highest-value signals are Chromium-only, and the dashboard says so rather than
reporting zeros:

| Signal | Chromium / Foundry desktop | Firefox |
|---|---|---|
| Heap size, post-GC floor trend, leak detection | yes (`performance.memory`) | **no** |
| Long-task detection (the freeze list) | yes | **no** |
| Input latency (Event Timing) | yes | yes |
| Everything else — CPU, hooks, frames, timers, DOM, canvas, world data, network | yes | yes |

**An empty Memory tab or an empty long-task list in Firefox means "no data", not "no problem".**
The dashboard flags this explicitly on the Overview tab and on each affected tab, because a
blank chart reading as a clean bill of health is exactly the failure mode a diagnostic tool
must not have. The Memory tab's growth indicators (live listeners, DOM nodes, chat DOM, live
intervals) do not depend on `performance.memory` and remain fully valid in Firefox — a leak
almost always shows up there too.

If you are chasing a memory or freeze problem specifically, run one session in the Foundry
desktop client. For everything else Firefox is fine.

**Clipboard:** `navigator.clipboard` is undefined on non-secure origins — `http://` on anything
other than `localhost`. Copy buttons fall back to `execCommand`, and then to a selectable text
box, so they work regardless.

### Two measurements that are easy to get wrong, and how this handles them

**libWrapper envelopes.** A libWrapper `WRAPPER` receives the rest of the call chain as its first
argument. If it calls through, everything downstream — including the original core function —
runs inside it. Naively timing the wrapper bills the package for all of that.

This matters concretely: **libWrapper registers a pass-through wrapper on
`Application.prototype._render` under its own package id**, purely to catch render errors. Time
it naively and `lib-wrapper` is charged for every application render in the entire session and
appears at the top of the leaderboard consuming 30–40% of the main thread, which is nonsense.

The probe pushes a synthetic frame around the downstream call, so each wrapper's **own** cost is
measured exclusively and the downstream time is attributed to core (or to the next instrumented
wrapper). The libWrapper table shows **Own** and **Enveloped** side by side; only Own is charged.
A large envelope with a tiny own-share tells you the *wrapped function* is hot — go look at what
calls it, not at the package that wrapped it.

**Listener counts.** "Added minus `removeEventListener`" is a useless leak signal in Foundry:
applications discard their whole element on close without removing listeners, so opening and
closing one character sheet adds thousands to that counter permanently while retaining nothing.

The probe holds a `WeakRef` to each listener's target and sweeps them, so the DOM tab reports
**Attached** (target still connected to the document — the number that means something) beside
**Not removed** and **Collected**. A flat Attached with a climbing Not-removed is normal element
churn and is explicitly reported as *not* a leak. A climbing Attached — especially on `window` or
`document`, which survive an application close — is the real thing.

Foundry v13+ also removes listeners by aborting an `AbortSignal` rather than calling
`removeEventListener`, so the probe hooks the signal's `abort` event too; otherwise those
registrations would look permanent forever.

### Verifying it yourself: the retention test

Counting listeners at a single moment tells you nothing, because you cannot know what *should*
have been released. **DOM tab → Listener retention test** turns it into a controlled experiment:

1. **Mark baseline** with nothing open.
2. Open the window you suspect, then close it. Repeat two or three times.
3. Read **Added** against **Still attached**.

`Still attached ≈ 0` with a large `Added` → nothing is leaking, and the raw registration counter
was simply the wrong thing to watch. `Still attached ≈ Added` → a real leak, and the
**Attached to** column names the surviving target. For anything genuinely retained the panel
prints the registration stack, so you get the file and line rather than just a package name.

Same thing from the console:

```js
const api = game.modules.get("dmm-performance-checker").api;
api.listenerBaseline();   // then open and close the sheet
api.listenerDelta();      // console.table of added vs still-attached, per package and event
```

### Checking without trusting this module

Reasonable thing to want, given the counters here have been wrong twice. The retention panel has
a **Check this without trusting my counters** section containing a console snippet that shares no
code with this module — it patches `addEventListener` fresh and tallies net add-minus-remove per
target kind. Paste it, note `__ltNodes()`, open and close the sheet, then run `__lt()` and
`__ltNodes()` again.

Read it as: rows with target **element** climbing are expected, because those elements are
discarded on close. Rows with target **window**, **document** or **body** climbing are the real
leak, because those targets outlive any application. If the node count returns to its starting
value, the sheet's DOM was removed and its listeners went with it.

**Pop-out windows are the exception to that rule.** From v14 an application can be detached into
its own browser window, whose `window` and `document` do *not* outlive the application — they
die when the user closes the pop-out. Those targets are labelled `detached-window` and
`detached-document` rather than `window` and `document` precisely so they cannot be mistaken for
the persistent kind, and the sweep releases them the moment the window closes. A listener on a
`detached-window` row is not a leak.

**Firefox DevTools specifics** (worth stating precisely, because the Chrome advice does not
transfer): Firefox has **no Event Listeners sidebar panel**, and **`getEventListeners()` does not
exist** — that is a Chrome-only command line API. What Firefox has is an **`event` badge** next to
elements in the Inspector's HTML pane; clicking it opens a popup listing that element's listeners
with file and line, plus an arrow that jumps to the code in the Debugger. It is per-element, so
for a whole-page count use the snippet.

**Other honest limits:**

- Attribution is by stack trace. A module bundled with no recoverable path in its frames (rare,
  but possible with certain `eval`/blob loaders) will land in `unattributed`.
- "Retained" memory is a bounded object-graph walk of what a module hangs off its public API.
  It cannot see closures. A large number is evidence; a small number is not counter-evidence.
- Canvas display objects are only attributed to modules if you enable the deep canvas probe,
  which patches `PIXI.Container#addChild` — hot enough that it is off by default.
- The probe measures a single client. A module that wrecks your players' performance while
  leaving yours fine will show up here only through its socket traffic and database writes.

---

## What it costs

Benchmarked with `node test/bench.mjs`:

| Case | Baseline | Instrumented | Added |
|---|---|---|---|
| Hook dispatch, trivial callback | ~20–80 ns | ~185 ns | **+105–160 ns** |
| Hook dispatch, realistic (~2 µs) callback | ~280 ns | ~440 ns | **+160 ns** |
| DOM append + remove pair | 29 ns | 37 ns | **+8 ns** |

At a heavy 50,000 instrumented callbacks per second, that is ~8 ms/s — under **1% of one core**.
The trivial-callback row swings between runs because the baseline is small enough to be mostly
measurement noise; judge by the realistic row, which is stable.

The probe measures its own overhead continuously and prints it in the dashboard footer. If it
exceeds the configured budget (default 1.5%) over a meaningful window, it degrades stack
sampling to 1-in-16 and says so. Counts and timings stay exact; only ownership of newly-seen
callbacks is sampled. It recovers automatically when the load passes.

The dashboard's own DOM and canvas censuses are TTL-cached so live refresh does not re-walk a
30,000-object scene graph every two seconds. Its render cost and census cost are both shown in
the footer. **If those numbers are large, distrust everything above them.**

---

## The three workflows that actually find things

### 1. Idle churn test — for "it's just always sluggish"

Overview tab → *Run 6-second idle test*. Sit still and touch nothing.

In a healthy world almost nothing should happen. Whatever a module does during this window, it
does forever, every session, whether or not anyone is playing. This is the cleanest signal in
the whole tool because there is no confounding activity.

Anything above ~1% CPU while idle is worth investigating. Anything above 3% is a finding.

### 2. Live muting — for "I think it's module X"

Modules tab → *Mute* next to the suspect. Its hook callbacks, timers, listeners, ticker
callbacks and libWrapper wrappers become no-ops immediately. Watch the FPS readout in the
toolbar for 20–30 seconds, then unmute (or wait — it auto-unmutes after three minutes).

This is a **diagnostic, not a fix**. A muted module will misbehave until unmuted. Don't do it
mid-combat and expect automation to work. But it is dramatically faster than
disable-reload-relogin bisection, and unlike bisection it gives you a *quantitative* delta
rather than a yes/no.

For `libWrapper` wrappers the mute deliberately calls through to the next function in the chain
rather than returning `undefined`, so muting a module does not delete the core behaviour it
wraps.

### 3. Snapshot diff — for "it gets worse over a long session"

Snapshots tab → *Take snapshot* at the start of the session. Play. Take another two or three
hours in. Read the diff.

A leak is always a counter that only goes one way. The diff names which one — live listeners,
DOM elements, canvas objects, chat DOM, live intervals, retained bytes — and which package
owns it. This is the thing you cannot see from any single point in time, and it is the specific
answer to "why does hour four feel different from hour one".

---

## Reading the tabs

**Overview** — vitals, ranked module impact, and findings. Each finding states the measurement
it rests on and what to do next. *Copy as text* dumps them all for pasting into a bug report.

**Clicking a finding freezes it.** The dashboard refreshes every two seconds, which makes inline
expanders useless — they collapse on re-render and the numbers move while you're reading them.
Instead, clicking a finding opens its own window containing a deep copy of the finding *and* all
the supporting evidence as it stood at that instant: the module's scorecard row, its hook
callbacks, its live background timers, its DOM listeners, its slowest recent calls, the long
tasks it contributed to, its errors with stacks, and whichever census slice the finding rests on
(canvas state, DOM state, world flag data, heap history, input latency, socket traffic).

That window never updates. Open several and compare them side by side, or open one before and
one after a change. Each has a *Copy finding + evidence* button that produces a paste-ready
summary, and owner-scoped findings get a *Mute and watch FPS* button so you can test the
hypothesis without leaving the window. Errors on the Errors tab work the same way.

**Modules** — the scorecard. `Impact` is a composite weighted toward what you actually feel:
sustained CPU share and per-frame cost dominate; a one-off 200 ms at startup barely registers.
Sort by any column.

**Hooks** — one row per (hook, package). `Self` excludes time spent inside nested instrumented
calls, so a module that merely *triggers* other modules' work is not blamed for it. Sort by
`Calls/min` to find hooks firing far more often than they should. The libWrapper table shows
wrapper stacking depth on hot core functions.

**Frames** — the frame-time histogram and, more usefully, **per-frame work by package**. PIXI
ticker callbacks run on every single frame.

The frame budget is measured from your actual display, not assumed to be 60 Hz. On a 165 Hz
monitor the budget is **6.1 ms**, so a module costing 2 ms/frame is using a third of it rather
than the 12% that 60 Hz-based advice implies. High refresh rates make module cost hurt sooner,
not later — every percentage on this tab is relative to your real budget.

Input is split into two tables, deliberately:

- **Discrete input** (clicks, key presses) is the only thing that reliably means "the UI felt
  slow". Each row breaks the total into **Queued** (the browser was busy and couldn't start —
  blame long tasks), **Handler** (a listener did real work — blame the module) and **Paint**
  (waiting for the next frame — blame canvas or layout cost). Those three have completely
  different fixes, so the split matters more than the total.
- **Hover and move events** are shown separately because the Event Timing API measures from the
  input timestamp to the *next paint*, rounded up to 8 ms. On a constantly-rendering Foundry
  canvas a `pointerout` will happily report 184 ms while spending 2 ms in handlers. That is a
  measurement artefact, not lag, and it is quarantined here so it can't be mistaken for one.

**Memory** — heap over the session with a post-GC *floor* trend (raw heap sawtooths; the floor
is the signal), growth indicators comparing the first third of the session to the last, and
retained-size estimates per module.

**DOM** — where the node weight is, DOM churn by package, the event listener table, and the
observer table. Live listener counts should be roughly stable; a number that only climbs is a
leak. Applications that are **orphaned** — holding DOM connected to no document at all — are
flagged explicitly; applications merely **popped out** into a v14 detached window are not, since
they are attached to their own document and the node counts include them.

`MutationObserver`, `ResizeObserver`, `IntersectionObserver` and `requestIdleCallback` are owned
too. The browser schedules these, so nothing on the call stack identifies who asked for them and
they would otherwise all land in `unattributed`; the probe attributes them at *construction*,
where the registering package is still on the stack. An observer watching a busy subtree, or one
that writes layout back from inside its own callback, is a common cause of jank that no amount of
hook or ticker instrumentation will explain.

**Canvas** — texture VRAM (width × height × 4 regardless of file compression — an 8000×6000
webp that's 3 MB on disk is 192 MB in video memory), filter counts, layer object counts, scene
composition. If a scene has 5,000 walls and token vision on, that is a scene-design cost and no
amount of module muting will fix it.

**Data** — run the world scan. Walks every document including embedded tokens and items, and
measures how many bytes of flag data each module has written into your world. Flag bloat is the
usual explanation for slow world loads and slow scene switches. It also flags **orphaned flags
from uninstalled modules**, which are pure dead weight in every document load.

**Network** — runtime HTTP, socket traffic (which degrades *everyone's* client, invisible in
your own FPS graph), and load-time payload per package.

**Timeline** — long tasks (the freezes) with attribution by overlapping instrumented spans, and
the slowest recent callbacks.

**Errors** — deduplicated error signatures. A hook that throws on every invocation is often more
expensive than one doing real work, and its intended behaviour is broken on top of it.

---

## Before you blame a module

Most suspicions are shaped wrong. A module that registers a handful of lifecycle hooks and no
`requestAnimationFrame` callbacks is structurally very unlikely to be a frame-rate problem, no
matter how large it is — its risk is **memory and startup**, which is what **Memory → Retained by
module API**, **Modules → Timers** and the startup cost table at `ready` are for. A module that
ships a multi-megabyte bundle costs you parse time at world load and a permanent baseline heap,
visible in **Network → Load-time payload** and **Memory** — but it is not, by itself, a per-frame
cost.

If your actual complaint is stutter and dropped frames during play, the evidence more often points
at ticker callbacks, per-token filters, hot hooks like `refreshToken`, or texture VRAM. Run the
idle churn test first; it settles the question in six seconds.

The counter-hypothesis worth holding: on a large module list, the answer is frequently *not* one
villain but fifteen modules each taking 0.3 ms/frame. The Modules tab is sorted to make that
visible — if the top ten rows are all in the same band rather than one row dwarfing the rest,
muting any single module will disappoint you, and the fix is subtraction rather than a bug
report.

---

## Console API

```js
const api = game.modules.get("dmm-performance-checker").api;

await api.top();          // console.table of the ranked scorecard
await api.idle(6);        // run the idle churn test, table the result
api.mute("some-module");  // live mute / unmute
api.unmute("some-module");
api.reset();              // zero the counters, start a fresh measurement window
api.probe();              // the raw state object — everything is in here
```

Raw state also lives at `globalThis.DMMPC` for poking around before `ready`.

---

## Configuration

Dashboard toolbar → gear icon. Changes are stored in `localStorage` (not world settings,
because the probe must configure itself before `game.settings` exists) and take effect on
**reload**.

- **Instrumentation mode** — `full` (per-callback timing and attribution), `envelope` (hook fire
  rates only, no callback wrapping), `off`. Use `envelope` if you ever suspect the probe's
  callback wrapping is interfering with a module that inspects `Hooks.events` by function
  identity; you lose per-module attribution but keep everything else.
- **Deep canvas probe** — tags every display object with its creator. The only way to attribute
  canvas objects to modules, but it patches a very hot path. Turn it on for one diagnostic
  session, not permanently.
- Individual probes (DOM, listener, ticker, network, database, observer) can be disabled
  independently. The observer probe replaces the `MutationObserver`, `ResizeObserver` and
  `IntersectionObserver` constructors; it deliberately leaves `PerformanceObserver` alone,
  because the probe's own long-task and event-timing observers use it.
- **Overhead budget** — raise it if you want full attribution during a deliberate stress test.

---

## Tests

```
node test/run.mjs      # 130 assertions: attribution, timing, mute, leak registries, all probes,
                       #                hook registration bookkeeping, observers, pop-out windows
node test/render.mjs   # 128 assertions: every dashboard tab, the frozen detail modal,
                       #                degraded-browser handling, input-latency classification,
                       #                refresh-rate detection, findings rules, export payload,
                       #                the v14 census regressions
node test/bench.mjs    # overhead benchmark
```

The render suite asserts a few properties that are easy to assume and easy to get wrong:

- a captured detail snapshot does not change when live probe state is mutated underneath it
- hover events never produce a warning-level input finding, but genuinely slow clicks do
- queue-bound lag and handler-bound lag are described differently, because their fixes differ
- with no `performance.memory`, heap findings are suppressed rather than reported as zero
- 0.5 ms/frame is scored as ~8% of a 165 Hz budget, not ~3% of a 60 Hz one
- an application popped out into a v14 detached window is reported as attached, while one
  holding DOM connected to no document at all is still reported as orphaned

`test/harness.mjs` implements just enough of the DOM, PIXI and Foundry surfaces for the probe to
run under Node. It is not a Foundry emulator — it exists to prove the instrumentation and
attribution logic, which is the part most likely to be subtly wrong.

Several real bugs were found this way and are worth knowing about, because they are the kind of
thing that would have silently produced confident, wrong output:

1. The overhead self-throttle divided by elapsed time and ran at startup, when elapsed was ~2 ms.
   A single stack capture read as 2.5% and permanently disabled attribution for the whole
   session. It now requires a 20-second window and 1,000 samples before it will act, and it
   recovers.
2. `estimateSize` iterated `Map`s with `for (const [k, v] of map)`. Foundry's
   `Collection extends Map` overrides `Symbol.iterator` to yield *values*, so this threw on
   every Collection. It now goes through `.entries()` explicitly and never throws.
3. **Every `Hooks.once` registration was wrapped twice.** Core's `Hooks.once` is
   `return this.on(hook, fn, {once: true})`, and `this.on` is the patched one, so a callback the
   probe had already wrapped came straight back through the wrapper. Counts, calls and
   `hookTotal` were all doubled — and because `Hooks.events` then held a function the probe's
   original-to-wrapped map could not resolve, **`Hooks.off` silently failed and the callback
   stayed registered and kept firing.** A profiler that changes the behaviour of the thing it is
   measuring is the worst outcome available, so the regression test asserts the callback does not
   run, not merely that the counters look right. Startup is almost entirely `once` hooks, which
   means the "startup cost by module" table had been reporting roughly double throughout.
4. `Hooks.off(hook, id)` — the numeric form, which is how v14's own `once` auto-removal
   unregisters — released nothing, so `hookRegsLive` only ever climbed. Exactly the false leak
   signal this tool exists to debunk, produced by the tool itself.
5. Foundry v14 marks every package script `defer`, which reordered the probe behind the game
   system and every library module. See *Why it can attribute cost* above.
