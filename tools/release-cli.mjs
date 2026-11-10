/**
 * Publishes a GitHub release for a Foundry module. The repo's Release workflow
 * then builds and attaches module.json and module.zip.
 *
 *   npm run release                  asks patch / minor / major
 *   npm run release -- minor         skips the question
 *   npm run release -- 1.2.0         exact version
 *   npm run release -- --dry-run     checks, build and notes only; no commit, no release
 *   npm run release -- --no-edit     use the notes as they are, don't open the editor
 *
 * Release notes live in release-notes.md, newest first, one "# vX.Y.Z" heading
 * per release. Anything above the newest released heading is the draft (text
 * with no heading, or a heading that was never published). At release the
 * draft moves under a heading for the new version and opens in your editor;
 * what's under that heading when you close it becomes the release notes,
 * above the manifest link and GitHub's generated change list.
 *
 * Publishing sets module.json's version, commits module.json and
 * release-notes.md as "Release vX.Y.Z", pushes, and releases that commit.
 * Foundry only offers an update when the version goes up, so the new version
 * must be higher than both the latest release and module.json.
 *
 * The same file works in every module repo. It reads what it needs from the
 * repo (package.json scripts, tools/build.mjs, the git remote); anything that
 * differs goes in an optional release.config.json at the repo root:
 *
 *   {
 *     "branch": "main",
 *     "verify": "npm run verify",
 *     "build": "node tools/build.mjs {tag}",
 *     "workflow": "release.yml",
 *     "editor": "zed --wait",
 *     "notes": "release-notes.md"
 *   }
 *
 * Commands may use {tag} (v1.2.3) and {version} (1.2.3).
 *
 * The editor is release.config.json's, then RELEASE_EDITOR, VISUAL, EDITOR,
 * git's core.editor, then Zed or VS Code if installed. Zed and VS Code get
 * --wait added, so the script carries on when you close the tab.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/* -- pure helpers (tested in release-cli.test.mjs) ----------------------------------------- */

export const PARTS = ["patch", "minor", "major"];
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version) {
  const match = SEMVER.exec(String(version ?? "").trim());
  if (!match) throw new Error(`"${version}" isn't a version like 1.2.3.`);
  return { nums: match.slice(1, 4).map(Number), pre: match[4] ?? "" };
}

/** Bumps a version or tag by "patch" | "minor" | "major". A pre-release drops its suffix. */
export function bump(from, part) {
  let { nums: [major, minor, patch], pre } = parse(from);
  if (part === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (part === "minor") [minor, patch] = [minor + 1, 0];
  else if (part === "patch") patch = pre ? patch : patch + 1;
  else throw new Error(`"${part}" isn't patch, minor or major.`);
  return `${major}.${minor}.${patch}`;
}

/** Negative, zero or positive, like a sort comparator. A pre-release sorts before its release. */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true });
}

/** The version to bump from: the higher of the latest release and module.json. */
export function baseVersion(...versions) {
  const valid = versions.filter((v) => v && SEMVER.test(String(v).trim())).map((v) => String(v).trim().replace(/^v/, ""));
  return valid.sort(compareVersions).pop() ?? null;
}

/**
 * Turns an answer into a version: a part name, its number in the menu
 * (1 patch, 2 minor, 3 major), or an exact version. Returns null if
 * the answer is none of those.
 */
export function resolveVersion(answer, base) {
  const a = String(answer ?? "").trim().toLowerCase();
  const part = PARTS.find((p, i) => a === p || a === String(i + 1));
  if (part) return base ? bump(base, part) : null;
  return SEMVER.test(a) ? a.replace(/^v/, "") : null;
}

/** Fills {tag} and {version} in a configured command. */
export function fill(command, version) {
  return command.replaceAll("{tag}", `v${version}`).replaceAll("{version}", version);
}

/** Sets "version" in module.json's text, leaving the rest of its formatting alone. */
export function setManifestVersion(json, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/;
  if (!pattern.test(json)) throw new Error('module.json has no "version" field.');
  return json.replace(pattern, `$1${version}$2`);
}

/* -- release notes -- */

/** Where the Release workflow puts the manifest link. Invisible in rendered markdown. */
export const MANIFEST_MARKER = "<!-- manifest -->";

const HEADING = /^# v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$).*$/gm;
const COMMENTS = /<!--[\s\S]*?-->/g;

const placeholder = (version) =>
  `<!-- Notes for v${version}: write or paste markdown, save, then close this tab. Comments are removed. -->`;

/** Splits release-notes.md into what's above the first version heading and the sections. */
export function parseNotes(text) {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  const matches = [...src.matchAll(HEADING)];
  const preamble = src.slice(0, matches[0]?.index ?? src.length);
  const sections = matches.map((m, i) => ({
    version: m[1],
    heading: m[0],
    body: src.slice(m.index + m[0].length, matches[i + 1]?.index ?? src.length),
  }));
  return { preamble, sections };
}

/**
 * Moves the draft under a "# v{version}" heading at the top. The draft is the
 * text above the first heading plus any leading sections whose version was
 * never released (a cancelled run, or a version you changed your mind about).
 * @param {Set<string>} released  Versions that have a tag, without the "v".
 */
export function draftNotes(text, version, released) {
  const { preamble, sections } = parseNotes(text);
  let i = 0;
  while (i < sections.length && !released.has(sections[i].version)) i++;
  const draft = [preamble, ...sections.slice(0, i).map((s) => s.body)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const rest = sections.slice(i).map((s) => s.heading + s.body).join("").trim();
  return `# v${version}\n\n${draft || placeholder(version)}\n${rest ? `\n${rest}\n` : ""}`;
}

/**
 * Cleans the new version's section (comments removed) and returns its notes
 * with the file text to save. Null if the heading is gone.
 */
export function finishNotes(text, version) {
  const { preamble, sections } = parseNotes(text);
  const section = sections.find((s) => s.version === version);
  if (!section) return null;
  const notes = section.body.replace(COMMENTS, "").trim();
  section.body = notes ? `\n\n${notes}\n\n` : "\n\n";
  const out = preamble + sections.map((s) => s.heading + s.body).join("");
  return { notes, text: `${out.trimEnd()}\n` };
}

/** The notes to publish, then the marker the workflow swaps for the manifest link. */
export function releaseBody(notes) {
  const clean = String(notes ?? "").replace(COMMENTS, "").trim();
  return clean ? `${clean}\n\n${MANIFEST_MARKER}\n` : `${MANIFEST_MARKER}\n`;
}

/* -- config -- */

/**
 * The editor command for release notes, or null to ask in the terminal.
 * Editors that return straight away get their wait flag added.
 */
export function pickEditor({ configured, env = {}, gitEditor, installed = [] }) {
  // "true" and ":" are how git and some tools say "no editor".
  const usable = (cmd) => Boolean(cmd?.trim()) && !["true", ":"].includes(cmd.trim());
  const found = [configured, env.RELEASE_EDITOR, env.VISUAL, env.EDITOR, gitEditor].find(usable) ?? installed[0];
  if (!found) return null;
  const command = found.trim();
  // The program is the quoted path, or the first word; split on either slash so
  // a Windows path reads the same on any OS.
  const first = command.startsWith('"') ? command.slice(1, command.indexOf('"', 1)) : command.split(/\s+/)[0];
  const program = first.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd)$/, "");
  const waits = /(^|\s)(-w|--wait)(\s|$)/.test(command);
  return ["zed", "code"].includes(program) && !waits ? `${command} --wait` : command;
}

/** Default config from what the repo has, with release.config.json on top. */
export function config({ pkg, hasBuildScript, hasVerifyPs1, overrides }) {
  const scripts = pkg?.scripts ?? {};
  const defaults = {
    branch: "main",
    verify: scripts.verify ? "npm run verify" : hasVerifyPs1 ? "pwsh -NoProfile -File verify.ps1" : null,
    build: scripts.build ? "npm run build -- {tag}" : hasBuildScript ? "node tools/build.mjs {tag}" : null,
    workflow: "release.yml",
    editor: null,
    notes: "release-notes.md",
  };
  return { ...defaults, ...overrides };
}

/* -- side effects --------------------------------------------------------------------------- */

const root = resolve(fileURLToPath(import.meta.url), "../..");

const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const tryRead = (cmd, args) => { try { return read(cmd, args); } catch { return ""; } };
const readJson = (file) => (existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), "utf8")) : null);

// shell: true so npm (npm.cmd on Windows) resolves. Versions are validated before use.
const run = (command) => spawnSync(command, { cwd: root, stdio: "inherit", shell: true }).status === 0;
const quiet = (command) => spawnSync(command, { cwd: root, stdio: "ignore", shell: true }).status === 0;
const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "inherit" }).status === 0;

// git may check text files out with CRLF on Windows; keep whichever the file has.
const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
function writeText(file, text, like) {
  writeFileSync(file, /\r\n/.test(like) ? text.replace(/\r?\n/g, "\r\n") : text);
}

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** Puts the draft under the new heading, opens it, and returns the cleaned notes. */
async function editNotes(cfg, file, version, released, { noEdit }) {
  const original = readText(file);
  writeText(file, draftNotes(original, version, released), original);
  if (!noEdit) {
    const editor = pickEditor({
      configured: cfg.editor,
      env: process.env,
      gitEditor: tryRead("git", ["config", "core.editor"]),
      installed: ["zed", "code"].filter((cmd) => quiet(`${cmd} --version`)),
    });
    if (editor) {
      console.log(`\nOpening ${cfg.notes} with ${editor}. Write under "# v${version}", save, and close the tab.`);
      if (!run(`${editor} "${file}"`)) fail("The editor exited with an error. Nothing released.");
    } else {
      await ask(`\nEdit the "# v${version}" section of ${cfg.notes}, save it, then press Enter.`);
    }
  }
  const edited = readText(file);
  const finished = finishNotes(edited, version);
  if (!finished) fail(`${cfg.notes} has no "# v${version}" heading any more. Nothing released.`);
  writeText(file, finished.text, edited);
  return finished.notes;
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const noEdit = argv.includes("--no-edit");
  const choice = argv.find((a) => !a.startsWith("--"));

  const cfg = config({
    pkg: readJson("package.json"),
    hasBuildScript: existsSync(join(root, "tools/build.mjs")),
    hasVerifyPs1: existsSync(join(root, "verify.ps1")),
    overrides: readJson("release.config.json") ?? {},
  });
  const manifestFile = join(root, "module.json");
  const notesFile = join(root, cfg.notes);
  const manifest = readJson("module.json") ?? fail("No module.json at the repo root.");

  // Release exactly what's on GitHub, so the tag matches what was tested. The
  // notes file may have uncommitted drafting; it's committed with the release.
  if (!quiet("gh auth status")) fail("GitHub CLI isn't signed in. Run: gh auth login");
  if (read("git", ["branch", "--show-current"]) !== cfg.branch) fail(`Switch to ${cfg.branch} first.`);
  const dirty = read("git", ["diff", "--name-only", "HEAD"]).split("\n").filter((path) => path && path !== cfg.notes);
  if (dirty.length) fail(`Commit or discard these first:\n  ${dirty.join("\n  ")}`);
  read("git", ["fetch", "--quiet", "origin", cfg.branch]);
  if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", `origin/${cfg.branch}`])) {
    fail(`Local ${cfg.branch} and origin/${cfg.branch} differ. Push or pull first.`);
  }
  if (!existsSync(join(root, ".github/workflows", cfg.workflow))) {
    fail(`No .github/workflows/${cfg.workflow}, so nothing would build the zip.`);
  }

  const released = new Set(
    tryRead("git", ["ls-remote", "--tags", "origin"]).split("\n")
      .map((line) => /refs\/tags\/v([^\^]+)$/.exec(line)?.[1]).filter(Boolean),
  );
  const latest = tryRead("gh", ["release", "view", "--json", "tagName", "--jq", ".tagName"]);
  const base = baseVersion(latest, manifest.version);

  let version = choice && resolveVersion(choice, base);
  if (choice && !version) fail(`"${choice}" isn't patch, minor, major or a version like 1.2.3.`);

  if (!version) {
    console.log(`\n${manifest.id}: latest release ${latest || "none"}, module.json ${manifest.version ?? "none"}`);
    if (base) PARTS.forEach((p, i) => console.log(`  ${i + 1}) ${p.padEnd(5)}  v${bump(base, p)}`));
    const prompt = base ? "Choose 1-3, or type a version: " : "First release version (like 1.0.0): ";
    while (!version) {
      const answer = await ask(prompt);
      if (!answer) { console.log("Cancelled."); return; }
      version = resolveVersion(answer, base);
      if (!version) console.log("Not a choice or a version like 1.2.3.");
    }
  }
  const tag = `v${version}`;

  if (base && compareVersions(version, base) <= 0) {
    fail(`${tag} isn't higher than ${base}, so Foundry wouldn't offer it as an update.`);
  }
  if (released.has(version)) fail(`${tag} already exists on GitHub.`);

  if (cfg.verify) {
    console.log(`\n> ${cfg.verify}`);
    if (!run(cfg.verify)) fail("Checks failed. Nothing released.");
  } else console.warn("No verify command found; skipping checks.");

  // Same build the workflow runs; catches a bad manifest before anything changes.
  if (cfg.build) {
    const build = fill(cfg.build, version);
    console.log(`\n> ${build}`);
    if (!run(build)) fail("Build failed. Nothing released.");
  }

  const notes = await editNotes(cfg, notesFile, version, released, { noEdit });
  console.log(notes ? `\nNotes for ${tag}:\n${notes.replace(/^/gm, "  | ")}` : `\nNo notes for ${tag}; just the generated ones.`);

  if (dryRun) {
    console.log(`\nDry run: would set module.json to ${version}, commit "Release ${tag}", push and publish.`);
    console.log(`${cfg.notes} keeps the "# ${tag}" section; the next run picks it up again.`);
    return;
  }

  const question = `\nSet module.json to ${version}, commit "Release ${tag}", push to ${cfg.branch} and publish? [y/N] `;
  if (!yes && (await ask(question)).toLowerCase() !== "y") {
    console.log(`Cancelled. Your notes are saved in ${cfg.notes}.`);
    return;
  }

  const manifestText = readText(manifestFile);
  writeText(manifestFile, setManifestVersion(manifestText, version), manifestText);
  if (!git("add", "--", "module.json", cfg.notes) || !git("commit", "-m", `Release ${tag}`)) {
    fail("Commit failed. module.json and the notes are changed but not committed; nothing released.");
  }
  if (!git("push", "origin", `HEAD:${cfg.branch}`)) {
    fail(`Push failed. "Release ${tag}" is committed locally; push it, then publish with:\n  gh release create ${tag} --target ${cfg.branch} --title ${tag} --generate-notes`);
  }
  const sha = read("git", ["rev-parse", "HEAD"]);

  // Creates the tag on GitHub at the release commit and publishes, which starts
  // the Release workflow. gh puts the notes file above the generated notes.
  const temp = mkdtempSync(join(tmpdir(), "release-"));
  const bodyFile = join(temp, "notes.md");
  writeFileSync(bodyFile, releaseBody(notes));
  const created = run(`gh release create ${tag} --target ${sha} --title ${tag} --generate-notes --notes-file "${bodyFile}"`);
  rmSync(temp, { recursive: true, force: true });
  if (!created) fail(`gh release create failed. "Release ${tag}" is pushed; publish it from GitHub's Releases page.`);

  // A release event's run reports the tag as its branch; wait for it to appear.
  let runId = "";
  for (let i = 0; i < 15 && !runId; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    runId = tryRead("gh", ["run", "list", "--workflow", cfg.workflow, "--event", "release", "--branch", tag,
      "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]);
  }
  if (!runId) fail(`Released ${tag}, but couldn't find its workflow run. Check the Actions tab.`);
  if (!run(`gh run watch ${runId} --exit-status`)) fail(`Workflow failed for ${tag}. The release exists without its files.`);

  const repo = read("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  console.log(`\nReleased ${tag}.`);
  console.log(`  This version: https://github.com/${repo}/releases/download/${tag}/module.json`);
  console.log(`  Latest:       https://github.com/${repo}/releases/latest/download/module.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => fail(error.message));
}
