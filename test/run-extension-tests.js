const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(root, '.test-integration-dist');
const extensionTestsPath = path.join(outputDirectory, 'index.js');
const userDataDirectory = path.join(outputDirectory, 'user-data');
const extensionsDirectory = path.join(outputDirectory, 'extensions');

async function main() {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'integration', 'index.ts')],
      outfile: extensionTestsPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode']
    });
    const settingsDirectory = path.join(userDataDirectory, 'User');
    fs.mkdirSync(settingsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDirectory, 'settings.json'),
      `${JSON.stringify({ 'dinotty.serverUrl': 'https://legacy.example.com/base/' }, null, 2)}\n`
    );
    await runTests({
      version: '1.90.0',
      extensionDevelopmentPath: root,
      extensionTestsPath,
      extensionTestsEnv: {
        DINOTTY_TEST_USER_DATA: userDataDirectory
      },
      launchArgs: [
        `--user-data-dir=${userDataDirectory}`,
        `--extensions-dir=${extensionsDirectory}`
      ]
    });
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Dinotty extension-host tests failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
