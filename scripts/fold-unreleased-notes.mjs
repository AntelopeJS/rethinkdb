import { readFileSync, writeFileSync } from "node:fs";

const CHANGELOG = "CHANGELOG.md";
const UNRELEASED = /^## Unreleased\n+([\s\S]*?)\n*(?=^## |(?![\s\S]))/m;
const FIRST_RELEASE = /^## v\S+\n[\s\S]*?(?=^### |^## |(?![\s\S]))/m;

/**
 * Moves the sections written under `## Unreleased` to the top of the release
 * section release-it-changelogen has just inserted above it, so the upgrade
 * notes of a release sit above its generated entries. A changelog without an
 * `## Unreleased` section is left unchanged.
 *
 * @param {string} changelog The changelog after release-it-changelogen wrote it.
 * @returns {string} The changelog with the unreleased sections folded in.
 */
function foldUnreleasedNotes(changelog) {
  const unreleased = UNRELEASED.exec(changelog);
  if (unreleased === null) {
    return changelog;
  }
  const remaining =
    changelog.slice(0, unreleased.index) +
    changelog.slice(unreleased.index + unreleased[0].length);
  const release = FIRST_RELEASE.exec(remaining);
  if (release === null || release.index >= unreleased.index) {
    throw new Error(
      `${CHANGELOG}: no generated release section above "## Unreleased" to fold its notes into`,
    );
  }
  const insertAt = release.index + release[0].length;
  return `${remaining.slice(0, insertAt)}${unreleased[1].trim()}\n\n${remaining.slice(insertAt)}`;
}

writeFileSync(CHANGELOG, foldUnreleasedNotes(readFileSync(CHANGELOG, "utf8")));
