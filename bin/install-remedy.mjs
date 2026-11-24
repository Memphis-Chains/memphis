/**
 * The sentence the operator needs when the CLI cannot load because a
 * native binding was never built.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured 2026-11-24 on this host against the PUBLISHED v1.14.1 tarball,
 * installed into a clean prefix with npm 12.0.2: the install succeeded and
 * every command failed with
 *
 *   [ERROR] Failed to load Memphis CLI: Could not locate the bindings file.
 *   Tried: → .../better-sqlite3/build/Release/better_sqlite3.node → ... (13 paths)
 *
 * The package was not broken. npm 12 blocks dependency install scripts by
 * default, `better-sqlite3` ships no prebuilt binding, and the script that
 * fetches one never ran. The operator was left with thirteen candidate paths
 * and no sentence saying what to do.
 *
 * The remedy is one line in the PROJECT that installs memphis, because npm
 * reads `allowScripts` from the project root — a published package cannot
 * approve its own dependencies:
 *
 *   { "allowScripts": { "better-sqlite3": true } }
 *
 * This module is separate from `bin/memphis.js` for one reason: it is pure
 * and side-effect free, so a test can call it. The bin script runs the CLI
 * on import, which no test wants.
 */

/**
 * @param {string} message  the failure message the CLI caught.
 * @returns {string[] | null} the lines to print, or null when this failure
 *   is not a missing native binding and the raw error should stay the
 *   message.
 */
export function nativeBindingRemedy(message) {
  if (!message.includes('better_sqlite3.node')) return null;
  return [
    '',
    "[ERROR] The install never built better-sqlite3's native binding.",
    '[ERROR] npm 12 and newer block dependency install scripts by default, and',
    '[ERROR] they read the "allowScripts" field from the PROJECT ROOT — a',
    '[ERROR] published package cannot approve its own dependencies.',
    '[ERROR] In the project that installs memphis, add:',
    '[ERROR]   { "allowScripts": { "better-sqlite3": true } }',
    '[ERROR] then reinstall. See "Installing on npm 12 and newer" in README.md.',
  ];
}
