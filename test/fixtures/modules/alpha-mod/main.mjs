/** Fixture: pretends to be a well-behaved module that nonetheless costs something. */
export function register() {
  Hooks.on("testHook", (n) => {
    let x = 0;
    for (let i = 0; i < (n || 20000); i++) x += Math.sqrt(i);
    // Nested dispatch — proves self-time excludes callees.
    Hooks.callAll("innerHook");
    return x;
  });
}

export function registerNamed(fn) {
  Hooks.on("namedHook", fn);
  return fn;
}

export function startInterval(delay) {
  return setInterval(() => {}, delay);
}

export function addListener(target, type, fn) {
  target.addEventListener(type, fn);
}

export function domWork(node, n) {
  for (let i = 0; i < n; i++) node.appendChild(document.createElement("span"));
  node.innerHTML = "<b>hello</b>";
}

export function storageWork(n) {
  for (let i = 0; i < n; i++) localStorage.setItem(`alpha.k${i}`, "x".repeat(50));
}

export function throwingHook() {
  Hooks.on("boomHook", () => { throw new Error("alpha exploded"); });
}

export function tickerWork(ticker) {
  ticker.add(function alphaTick() {
    let x = 0;
    for (let i = 0; i < 5000; i++) x += i;
    return x;
  });
}

export async function dbWork() {
  await foundry.abstract.Document.updateDocuments([{ _id: "a" }, { _id: "b" }]);
}

/* The registrations below must live inside this file: attribution is by stack, so a hook
   registered from the test runner would (correctly) be blamed on the test runner. */
export function registerDomHook(node, n) {
  Hooks.on("domHook", () => domWork(node, n));
}
export function registerStorageHook(n) {
  Hooks.on("storeHook", () => storageWork(n));
}
export function registerDbHook() {
  Hooks.on("dbHook", () => dbWork());
}
export function registerBusyHook(iterations) {
  Hooks.on("scoreHook", () => {
    let x = 0;
    for (let i = 0; i < iterations; i++) x += Math.sqrt(i);
    return x;
  });
}

/* ---- registrations used by the v14 regression tests -------------------------------------- */

/** `Hooks.once` from module code, so attribution sees a module frame on the stack. */
export function registerOnce(hook, fn) {
  return Hooks.once(hook, fn);
}

/** `Hooks.on` returning the numeric id, for the unregister-by-id path. */
export function registerReturningId(hook, fn) {
  return Hooks.on(hook, fn);
}

export function observe(kind, target, cb) {
  const obs = new globalThis[kind](cb);
  obs.observe(target);
  return obs;
}

export function scheduleIdle(fn) {
  return requestIdleCallback(fn);
}

export function listenTo(target, type, fn) {
  target.addEventListener(type, fn);
}
