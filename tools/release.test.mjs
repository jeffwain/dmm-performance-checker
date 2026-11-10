import test from "node:test";
import assert from "node:assert/strict";

import { versionFromTag, releaseManifest, manifestFiles } from "./release.mjs";

test("versionFromTag accepts v-prefixed and bare versions, and rejects other tags", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v2.0.0-beta.1"), "2.0.0-beta.1");
  assert.throws(() => versionFromTag("release-1"));
  assert.throws(() => versionFromTag("v1.2"));
  assert.throws(() => versionFromTag(undefined));
});

test("releaseManifest keeps the source fields and points URLs at this release", () => {
  const source = { id: "dmm-performance-checker", version: "0.0.0", url: "old", esmodules: ["module/main.mjs"] };
  const out = releaseManifest(source, { version: "1.2.3", repo: "owner/repo", tag: "v1.2.3" });
  assert.deepEqual(out, {
    id: "dmm-performance-checker",
    version: "1.2.3",
    url: "https://github.com/owner/repo",
    manifest: "https://github.com/owner/repo/releases/latest/download/module.json",
    download: "https://github.com/owner/repo/releases/download/v1.2.3/module.zip",
    bugs: "https://github.com/owner/repo/issues",
    esmodules: ["module/main.mjs"],
  });
  assert.equal(source.version, "0.0.0", "source manifest is not mutated");
});

test("manifestFiles lists scripts, styles and language files", () => {
  const files = manifestFiles({
    esmodules: ["module/main.mjs"],
    styles: ["a.css"],
    languages: [{ lang: "en", path: "languages/en.json" }],
  });
  assert.deepEqual(files, ["module/main.mjs", "a.css", "languages/en.json"]);
});
