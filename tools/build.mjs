/**
 * Stages a release in dist/:
 *   dist/module.json   the release manifest (uploaded to the GitHub release)
 *   dist/package/      the files that go in module.zip
 *
 *   npm run build -- v1.2.3
 *
 * The repo comes from GITHUB_REPOSITORY (set in GitHub Actions), git's origin
 * remote, or module.json's url.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const RUNTIME_PATHS = [
  "README.md", "LICENSE", "assets", "icons", "lang", "languages",
  "module", "packs", "scripts", "sounds", "styles", "templates",
];
const isTest = (path) => /\.test\.m?js$/.test(path);

/** "v1.2.3" or "1.2.3" -> "1.2.3". Throws on anything that isn't a version. */
export function versionFromTag(tag) {
  const version = String(tag ?? "").trim().replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`"${tag}" isn't a release version. Tag releases like v1.2.3.`);
  }
  return version;
}

/** Extracts "owner/repo" from the first matching GitHub URL, remote, or "owner/repo" string. */
export function repoSlug(...candidates) {
  for (const candidate of candidates) {
    const match = String(candidate ?? "").trim().match(/(?:^|github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/);
    if (match) return match[1];
  }
  throw new Error("Couldn't find GitHub owner/repo from GITHUB_REPOSITORY, git origin, or module.json.");
}

/**
 * The manifest that ships with a release. `manifest` stays on "latest" so
 * installed copies keep finding updates; `download` pins this version's zip.
 * @param {object} source  The repo's module.json.
 * @param {{version:string, repo:string, tag?:string}} release  repo is "owner/name".
 */
export function releaseManifest(source, { version, repo, tag = `v${version}` }) {
  const base = `https://github.com/${repo}`;
  return {
    ...source,
    version,
    url: base,
    manifest: `${base}/releases/latest/download/module.json`,
    download: `${base}/releases/download/${tag}/module.zip`,
    bugs: `${base}/issues`,
  };
}

/** Every file a manifest asks Foundry to load, for checking they exist. */
export function manifestFiles(manifest) {
  return [
    ...(manifest.esmodules ?? []),
    ...(manifest.scripts ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map((lang) => lang.path),
  ];
}

/** Top-level files and folders to copy into the release zip, if they exist in the repo. */
export function packageEntries(manifest, configured) {
  if (configured?.length) return configured;
  const referenced = manifestFiles(manifest).map((file) => file.replace(/^\.\//, "").split("/")[0]);
  return [...new Set([...RUNTIME_PATHS, ...referenced])];
}

function build(tagArg) {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const dist = join(root, "dist");
  const pkg = join(dist, "package");

  const version = versionFromTag(tagArg);
  const tag = `v${version}`;
  const source = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const overrides = existsSync(join(root, "release.config.json"))
    ? JSON.parse(readFileSync(join(root, "release.config.json"), "utf8"))
    : {};
  let origin = "";
  try { origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }); } catch {}

  const repo = repoSlug(process.env.GITHUB_REPOSITORY, origin, source.url, source.manifest);
  const manifest = releaseManifest(source, { version, repo, tag });

  const missing = manifestFiles(manifest).filter((file) => !existsSync(join(root, file)));
  if (missing.length) {
    console.error(`module.json lists files that don't exist:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  for (const entry of packageEntries(manifest, overrides.files)) {
    if (existsSync(join(root, entry))) {
      cpSync(join(root, entry), join(pkg, entry), { recursive: true, filter: (src) => !isTest(src) });
    }
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(pkg, "module.json"), json);
  writeFileSync(join(dist, "module.json"), json);

  console.log(`Built ${manifest.id} ${version} for ${repo} in dist/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build(process.argv[2]);
}
