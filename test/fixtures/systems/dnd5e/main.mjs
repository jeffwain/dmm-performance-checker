/**
 * Fixture: pretends to be the active game system. It lives under /systems/, not /modules/,
 * which is exactly the case package resolution used to get wrong.
 */
export function register() {
  Hooks.on("scoreHook", () => {
    let x = 0;
    for (let i = 0; i < 20000; i++) x += Math.sqrt(i);
    return x;
  });
}
