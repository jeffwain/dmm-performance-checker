import test from "node:test";
import assert from "node:assert/strict";

import { bump, resolveVersion, fill, config } from "./release-cli.mjs";

test("bump raises the chosen part and resets the ones below it", () => {
  assert.equal(bump("v0.1.9", "patch"), "0.1.10");
  assert.equal(bump("1.2.3", "minor"), "1.3.0");
  assert.equal(bump("v1.2.3", "major"), "2.0.0");
  assert.throws(() => bump("v1.2", "patch"));
  assert.throws(() => bump("1.2.3", "huge"));
});

test("bump of a pre-release finishes it rather than skipping a version", () => {
  assert.equal(bump("v1.2.3-beta.1", "patch"), "1.2.3");
  assert.equal(bump("v1.2.3-beta.1", "minor"), "1.3.0");
});

test("resolveVersion accepts names, menu numbers and exact versions", () => {
  for (const answer of ["patch", "1", " Patch "]) assert.equal(resolveVersion(answer, "v0.1.0"), "0.1.1");
  assert.equal(resolveVersion("2", "v0.1.0"), "0.2.0");
  assert.equal(resolveVersion("major", "v0.1.0"), "1.0.0");
  assert.equal(resolveVersion("m", "v0.1.0"), null, "minor and major share a first letter");
  assert.equal(resolveVersion("v2.0.0-rc.1", "v0.1.0"), "2.0.0-rc.1");
  assert.equal(resolveVersion("4", "v0.1.0"), null);
  assert.equal(resolveVersion("patch", ""), null, "no earlier release to bump from");
  assert.equal(resolveVersion("1.0.0", ""), "1.0.0");
});

test("fill substitutes tag and version", () => {
  assert.equal(fill("npm run build -- {tag} # {version}", "1.2.3"), "npm run build -- v1.2.3 # 1.2.3");
});

test("config prefers npm scripts, falls back to repo files, and lets overrides win", () => {
  const npmRepo = config({ pkg: { scripts: { verify: "x", build: "y" } }, hasBuildScript: true, hasVerifyPs1: true, overrides: {} });
  assert.equal(npmRepo.verify, "npm run verify");
  assert.equal(npmRepo.build, "npm run build -- {tag}");

  const bare = config({ pkg: null, hasBuildScript: true, hasVerifyPs1: true, overrides: {} });
  assert.equal(bare.verify, "pwsh -NoProfile -File verify.ps1");
  assert.equal(bare.build, "node tools/build.mjs {tag}");

  const custom = config({ pkg: null, hasBuildScript: false, hasVerifyPs1: false, overrides: { branch: "release", build: "make {tag}" } });
  assert.deepEqual(custom, { branch: "release", verify: null, build: "make {tag}", workflow: "release.yml" });
});
