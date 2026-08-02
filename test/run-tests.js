const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, '.test-dist');
const entries = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(__dirname, name));

async function main() {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  try {
    await esbuild.build({
      entryPoints: entries,
      outdir: outputDirectory,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18'
    });
    const tests = fs.readdirSync(outputDirectory)
      .filter((name) => name.endsWith('.test.js'))
      .map((name) => path.join(outputDirectory, name));
    const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
