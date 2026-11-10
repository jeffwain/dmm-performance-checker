import test from "node:test";
import assert from "node:assert/strict";

import {
  bump, compareVersions, baseVersion, resolveVersion, fill, setManifestVersion,
  parseNotes, draftNotes, finishNotes, releaseBody, pickEditor, config, MANIFEST_MARKER,
} from "./release.mjs";

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

test("compareVersions orders numerically and puts pre-releases first", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("v1.0.0", "1.0.0") === 0);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
});

test("baseVersion is the higher of the latest release and module.json", () => {
  assert.equal(baseVersion("v0.2.0", "1.0.0"), "1.0.0", "module.json ahead of releases");
  assert.equal(baseVersion("v1.2.0", "1.0.0"), "1.2.0");
  assert.equal(baseVersion("", "1.0.0"), "1.0.0");
  assert.equal(baseVersion("", undefined), null);
});

test("resolveVersion accepts names, menu numbers and exact versions", () => {
  for (const answer of ["patch", "1", " Patch "]) assert.equal(resolveVersion(answer, "1.0.0"), "1.0.1");
  assert.equal(resolveVersion("2", "1.0.0"), "1.1.0");
  assert.equal(resolveVersion("major", "1.0.0"), "2.0.0");
  assert.equal(resolveVersion("m", "1.0.0"), null, "minor and major share a first letter");
  assert.equal(resolveVersion("v2.0.0-rc.1", "1.0.0"), "2.0.0-rc.1");
  assert.equal(resolveVersion("4", "1.0.0"), null);
  assert.equal(resolveVersion("patch", null), null, "nothing to bump from");
  assert.equal(resolveVersion("1.0.0", null), "1.0.0");
});

test("fill substitutes tag and version", () => {
  assert.equal(fill("npm run build -- {tag} # {version}", "1.2.3"), "npm run build -- v1.2.3 # 1.2.3");
});

test("setManifestVersion changes only the version", () => {
  const json = '{\n  "id": "x",\n  "version": "1.0.0",\n  "compatibility": { "minimum": "13" }\n}\n';
  assert.equal(setManifestVersion(json, "1.1.0"), json.replace('"1.0.0"', '"1.1.0"'));
  assert.throws(() => setManifestVersion('{ "id": "x" }', "1.1.0"));
});

const LOG = "# v1.0.1\n\n- Fixed a thing\n\n# v1.0.0 — first\n\n- Hello\n";
const released = new Set(["1.0.0", "1.0.1"]);

test("parseNotes finds version headings, including ones with trailing text", () => {
  const { preamble, sections } = parseNotes(`draft\r\n\r\n${LOG}`);
  assert.equal(preamble, "draft\n\n");
  assert.deepEqual(sections.map((s) => s.version), ["1.0.1", "1.0.0"]);
  assert.equal(sections[1].heading, "# v1.0.0 — first");
});

test("draftNotes moves text above the first heading under the new version", () => {
  assert.equal(
    draftNotes(`## New\n- Faster census\n\n${LOG}`, "1.1.0", released),
    `# v1.1.0\n\n## New\n- Faster census\n\n${LOG}`,
  );
});

test("draftNotes picks up an unreleased heading from a cancelled run", () => {
  const cancelled = `# v1.0.2\n\n- Drafted earlier\n\n${LOG}`;
  assert.equal(draftNotes(cancelled, "1.1.0", released), `# v1.1.0\n\n- Drafted earlier\n\n${LOG}`);
  assert.equal(draftNotes(cancelled, "1.0.2", released), cancelled, "same version, nothing moves");
});

test("draftNotes leaves a placeholder when there's no draft, and starts a new file", () => {
  assert.match(draftNotes(LOG, "1.1.0", released), /^# v1\.1\.0\n\n<!-- Notes for v1\.1\.0.*-->\n\n# v1\.0\.1\n/);
  assert.match(draftNotes("", "1.0.0", new Set()), /^# v1\.0\.0\n\n<!--.*-->\n$/);
});

test("finishNotes returns the section's notes without comments and tidies the file", () => {
  const edited = `# v1.1.0\n\n<!-- placeholder -->\n- New thing\n\n${LOG}`;
  assert.deepEqual(finishNotes(edited, "1.1.0"), { notes: "- New thing", text: `# v1.1.0\n\n- New thing\n\n${LOG}` });
  assert.deepEqual(finishNotes(`# v1.1.0\n\n<!-- x -->\n${LOG}`, "1.1.0"), { notes: "", text: `# v1.1.0\n\n${LOG}` });
  assert.equal(finishNotes(LOG, "1.1.0"), null, "heading removed while editing");
});

test("releaseBody puts the manifest marker below the notes", () => {
  assert.equal(releaseBody("- New thing"), `- New thing\n\n${MANIFEST_MARKER}\n`);
  assert.equal(releaseBody(""), `${MANIFEST_MARKER}\n`);
});

test("pickEditor takes the first usable editor and makes Zed and VS Code wait", () => {
  assert.equal(pickEditor({ configured: "zed" }), "zed --wait");
  assert.equal(pickEditor({ configured: "zed -w" }), "zed -w");
  assert.equal(pickEditor({ env: { EDITOR: "C:\\Zed\\bin\\Zed.exe" } }), "C:\\Zed\\bin\\Zed.exe --wait");
  const spaced = '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd"';
  assert.equal(pickEditor({ env: { EDITOR: spaced } }), `${spaced} --wait`);
  assert.equal(pickEditor({ env: { EDITOR: "/Applications/Zed.app/Contents/MacOS/cli" } }), "/Applications/Zed.app/Contents/MacOS/cli");
  assert.equal(pickEditor({ env: { VISUAL: "code", EDITOR: "vim" } }), "code --wait");
  assert.equal(pickEditor({ env: { EDITOR: "vim" }, gitEditor: "zed --wait" }), "vim");
  assert.equal(pickEditor({ gitEditor: "true", installed: ["zed"] }), "zed --wait", "git's 'no editor' is skipped");
  assert.equal(pickEditor({ env: { EDITOR: "  " } }), null);
});

test("config prefers npm scripts, falls back to repo files, and lets overrides win", () => {
  const npmRepo = config({ pkg: { scripts: { verify: "x", build: "y" } }, hasBuildScript: true, hasVerifyPs1: true, overrides: {} });
  assert.equal(npmRepo.verify, "npm run verify");
  assert.equal(npmRepo.build, "npm run build -- {tag}");

  const bare = config({ pkg: null, hasBuildScript: true, hasVerifyPs1: true, overrides: {} });
  assert.equal(bare.verify, "pwsh -NoProfile -File verify.ps1");
  assert.equal(bare.build, "node tools/build.mjs {tag}");

  const custom = config({ pkg: null, hasBuildScript: false, hasVerifyPs1: false, overrides: { branch: "release", build: "make {tag}" } });
  assert.deepEqual(custom, {
    branch: "release", verify: null, build: "make {tag}", workflow: "release.yml", editor: null, notes: "release-notes.md",
  });
});
