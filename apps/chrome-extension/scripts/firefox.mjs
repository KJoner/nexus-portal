// 批次 G: the Firefox flavour — build into dist-firefox, run Mozilla's add-ons linter (the checks
// addons.mozilla.org runs before signing), then pack nexus-portal-firefox-v<version>.zip.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bin = (p) => resolve(root, '../../node_modules', p);
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

run([bin('vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { NEXUS_EXT_TARGET: 'firefox' });
// Errors fail the build; warnings are listed (see docs/extension.md「Firefox」for the known ones).
run([bin('addons-linter/bin/addons-linter'), 'dist-firefox']);
run(['scripts/package.mjs', '--firefox', ...process.argv.slice(2)]);
