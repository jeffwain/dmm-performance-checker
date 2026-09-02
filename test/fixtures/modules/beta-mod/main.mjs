/** Fixture: a second module, used to prove attribution separates correctly. */
export function register() {
  Hooks.on("innerHook", () => {
    let x = 0;
    for (let i = 0; i < 40000; i++) x += Math.sqrt(i);
    return x;
  });
}

export function scheduleTimeout(fn, delay) {
  return setTimeout(fn, delay);
}

/**
 * A pure pass-through error-catching wrapper — structurally identical to the one libWrapper
 * itself registers on Application.prototype._render. Its own cost is nil; everything it
 * "costs" belongs to the function it wraps.
 */
export function registerPassThroughWrapper(pkgId) {
  libWrapper.register(pkgId, "Application.prototype._render", function (wrapped, ...args) {
    return wrapped(...args);
  }, "WRAPPER");
}

/** A wrapper that genuinely does work of its own before calling through. */
export function registerBusyWrapper(pkgId, iterations) {
  libWrapper.register(pkgId, "Application.prototype._render", function (wrapped, ...args) {
    let x = 0;
    for (let i = 0; i < iterations; i++) x += Math.sqrt(i);
    globalThis.__sink = x;
    return wrapped(...args);
  }, "WRAPPER");
}

/** Attach listeners to a throwaway element, the way an application does on render. */
export function attachSheetListeners(makeEl, count) {
  const els = [];
  for (let i = 0; i < count; i++) {
    const el = makeEl();
    el.addEventListener("click", () => {});
    els.push(el);
  }
  return els;
}
