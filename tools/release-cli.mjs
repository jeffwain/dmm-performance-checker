/**
 * Publishes a GitHub release for a Foundry module. The repo's Release workflow
 * then builds and attaches module.json and module.zip.
 *
 *   npm run release                  asks patch / minor / major
 *   npm run release -- minor         skips the question
 *   npm run release -- 1.0.0         exact version
 *   npm run release -- --dry-run     checks and build only, publishes nothing
 *
 * The same file works in every module repo. It reads what it needs from the
 * repo (package.json scripts, tools/build.mjs, the git remote); anything that
 * differs goes in an optional release.config.json at the repo root:
 *
 *   {
 *     "branch": "main",
 *     "verify": "npm run verify",
 *     "build": "node tools/build.mjs {tag}",
 *     "workflow": "release.yml"
 *   }
 *
 * Commands may use {tag} (v1.2.3) and {version} (1.2.3).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/* -- pure helpers (tested in release-cli.test.mjs) ----------------------------------------- */

export const PARTS = ["patch", "minor", "major"];
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** Bumps a version or tag by "patch" | "minor" | "major". A pre-release drops its suffix. */
export function bump(from, part) {
  const match = SEMVER.exec(String(from ?? "").trim());
  if (!match) throw new Error(`"${from}" isn't a version like 1.2.3.`);
  let [major, minor, patch] = match.slice(1, 4).map(Number);
  const pre = Boolean(match[4]);
  if (part === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (part === "minor") [minor, patch] = [minor + 1, 0];
  else if (part === "patch") patch = pre ? patch : patch + 1;
  else throw new Error(`"${part}" isn't patch, minor or major.`);
  return `${major}.${minor}.${patch}`;
}

/**
 * Turns an answer into a version: a part name, its number in the menu
 * (1 patch, 2 minor, 3 major), or an exact version. Returns null if
 * the answer is none of those.
 */
export function resolveVersion(answer, latest) {
  const a = String(answer ?? "").trim().toLowerCase();
  const part = PARTS.find((p, i) => a === p || a === String(i + 1));
  if (part) return latest ? bump(latest, part) : null;
  return SEMVER.test(a) ? a.replace(/^v/, "") : null;
}

/** Fills {tag} and {version} in a configured command. */
export function fill(command, version) {
  return command.replaceAll("{tag}", `v${version}`).replaceAll("{version}", version);
}

/** Default config from what the repo has, with release.config.json on top. */
export function config({ pkg, hasBuildScript, hasVerifyPs1, overrides }) {
  const scripts = pkg?.scripts ?? {};
  const defaults = {
    branch: "main",
    verify: scripts.verify ? "npm run verify" : hasVerifyPs1 ? "pwsh -NoProfile -File verify.ps1" : null,
    build: scripts.build ? "npm run build -- {tag}" : hasBuildScript ? "node tools/build.mjs {tag}" : null,
    workflow: "release.yml",
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

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const choice = argv.find((a) => !a.startsWith("--"));

  const cfg = config({
    pkg: readJson("package.json"),
    hasBuildScript: existsSync(join(root, "tools/build.mjs")),
    hasVerifyPs1: existsSync(join(root, "verify.ps1")),
    overrides: readJson("release.config.json") ?? {},
  });
  const id = readJson("module.json")?.id ?? "module";

  // Release exactly what's on GitHub, so the tag matches what was tested.
  if (!tryRead("gh", ["auth", "status"])) fail("GitHub CLI isn't signed in. Run: gh auth login");
  if (read("git", ["branch", "--show-current"]) !== cfg.branch) fail(`Switch to ${cfg.branch} first.`);
  if (read("git", ["status", "--porcelain", "--untracked-files=no"])) fail("Commit or discard tracked changes first.");
  read("git", ["fetch", "--quiet", "origin", cfg.branch]);
  if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", `origin/${cfg.branch}`])) {
    fail(`Local ${cfg.branch} and origin/${cfg.branch} differ. Push or pull first.`);
  }
  if (!existsSync(join(root, ".github/workflows", cfg.workflow))) {
    fail(`No .github/workflows/${cfg.workflow}, so nothing would build the zip.`);
  }

  const latest = tryRead("gh", ["release", "view", "--json", "tagName", "--jq", ".tagName"]);
  let version = choice && resolveVersion(choice, latest);
  if (choice && !version) fail(`"${choice}" isn't patch, minor, major or a version like 1.2.3.`);

  if (!version) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n${id}: latest release is ${latest || "none yet"}`);
    if (latest) PARTS.forEach((p, i) => console.log(`  ${i + 1}) ${p.padEnd(5)}  v${bump(latest, p)}`));
    const prompt = latest ? "Choose 1-3, or type a version: " : "First release version (like 1.0.0): ";
    while (!version) {
      const answer = await rl.question(prompt);
      if (!answer.trim()) { rl.close(); console.log("Cancelled."); return; }
      version = resolveVersion(answer, latest);
      if (!version) console.log("Not a choice or a version like 1.2.3.");
    }
    rl.close();
  }
  const tag = `v${version}`;

  if (tryRead("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) fail(`${tag} already exists on GitHub.`);

  if (cfg.verify) {
    console.log(`\n> ${cfg.verify}`);
    if (!run(cfg.verify)) fail("Checks failed. Nothing released.");
  } else console.warn("No verify command found; skipping checks.");

  // Same build the workflow runs; catches a bad manifest before anything is published.
  if (cfg.build) {
    const build = fill(cfg.build, version);
    console.log(`\n> ${build}`);
    if (!run(build)) fail("Build failed. Nothing released.");
  }

  const head = read("git", ["rev-parse", "--short", "HEAD"]);
  if (dryRun) { console.log(`\nDry run: would publish ${tag} from ${head}.`); return; }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nPublish ${tag} from ${head}? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") { console.log("Cancelled."); return; }
  }

  // Creates the tag on GitHub and publishes, which starts the Release workflow.
  if (!run(`gh release create ${tag} --target ${cfg.branch} --title ${tag} --generate-notes`)) {
    fail("gh release create failed.");
  }

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
  console.log(`\nReleased ${tag}. Manifest: https://github.com/${repo}/releases/latest/download/module.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => fail(error.message));
}
