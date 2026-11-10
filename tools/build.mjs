/**
 * Stages a release in dist/:
 *   dist/module.json   the release manifest (uploaded to the GitHub release)
 *   dist/package/      the files that go in module.zip
 *
 *   npm run build -- v1.2.3
 *
 * The repo comes from GITHUB_REPOSITORY (set in GitHub Actions), falling back
 * to this repo's home for local test builds.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { versionFromTag, releaseManifest, manifestFiles } from "./release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const pkg = join(dist, "package");

// What Foundry needs at runtime. Tests, tools and .git stay out of the zip.
const SHIP = ["README.md", "lang", "module", "scripts", "styles"];

const tag = process.argv[2];
const version = versionFromTag(tag);
const repo = process.env.GITHUB_REPOSITORY || "jeffwain/dmm-performance-checker";

const source = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
const manifest = releaseManifest(source, { version, repo, tag });

const missing = manifestFiles(manifest).filter((file) => !existsSync(join(root, file)));
if (missing.length) {
  console.error(`module.json lists files that don't exist:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
for (const entry of SHIP) {
  cpSync(join(root, entry), join(pkg, entry), { recursive: true });
}

const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(pkg, "module.json"), json);
writeFileSync(join(dist, "module.json"), json);

console.log(`Built ${manifest.id} ${version} for ${repo} in dist/`);
