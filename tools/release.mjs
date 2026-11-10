/**
 * Pure helpers for the release build, kept apart from build.js so they can be
 * tested without touching the file system.
 */

/** "v1.2.3" or "1.2.3" -> "1.2.3". Throws on anything that isn't a version. */
export function versionFromTag(tag) {
  const version = String(tag ?? "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`"${tag}" isn't a release version. Tag releases like v1.2.3.`);
  }
  return version;
}

/**
 * The manifest that ships with a release. `manifest` stays on "latest" so
 * installed copies keep finding updates; `download` pins this version's zip.
 * @param {object} source  The repo's module.json.
 * @param {{version:string, repo:string, tag:string}} release  repo is "owner/name".
 */
export function releaseManifest(source, { version, repo, tag }) {
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
