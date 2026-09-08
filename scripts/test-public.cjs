// Run portable application tests without pretending production assets are bundled.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const productionOnly = new Set([
  'miniprogram/config/backend.test.js',
  'miniprogram/utils/projectConfig.test.js',
  'miniprogram/utils/sdkVendor.test.js',
  'server/src/automationRecoveryWorkflow.test.js',
  'server/src/cloudHostingDockerfile.test.js',
  'server/src/cloudHostingWorkflow.test.js',
  'server/src/foodcast/bgmLibrary.test.js',
]);
function walk(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const file = `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : file.endsWith('.test.js') ? [file] : [];
  });
}
const all = ['server/src', 'server/scripts', 'miniprogram/utils', 'miniprogram/config'].flatMap(walk);
const selected = all.filter(file => !productionOnly.has(file));
console.log(`Portable suite: ${selected.length} test files. Excluded production-asset checks:`);
console.log([...productionOnly].join('\n'));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...selected], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
