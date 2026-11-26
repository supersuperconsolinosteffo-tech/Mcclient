import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ZIG_PY = path.join(ROOT, '.venv/bin/python');
const OBJ_DIR = path.join(ROOT, 'native/obj');
const RELEASE_DIR = path.join(ROOT, 'release');
const RELEASE_BIN_DIR = path.join(RELEASE_DIR, 'bin');

fs.mkdirSync(OBJ_DIR, { recursive: true });
fs.mkdirSync(RELEASE_BIN_DIR, { recursive: true });

function toCByteArrayHeader(guardName, symbolPrefix, buffer, nullTerminate = false) {
  const bytes = nullTerminate ? Buffer.concat([buffer, Buffer.from([0])]) : buffer;
  const lines = [
    `#ifndef ${guardName}`,
    `#define ${guardName}`,
    `#include <cstddef>`,
    `#include <cstdint>`,
    `static const unsigned char ${symbolPrefix}Raw[${bytes.length}] = {`,
  ];

  const chunkSize = 24;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    lines.push('  ' + Array.from(slice, (b) => `0x${b.toString(16).padStart(2, '0')}`).join(',') + ',');
  }
  lines.push('};');
  if (nullTerminate) {
    lines.push(`static const char* ${symbolPrefix} = reinterpret_cast<const char*>(${symbolPrefix}Raw);`);
  } else {
    lines.push(`static const unsigned char* ${symbolPrefix}Data = ${symbolPrefix}Raw;`);
    lines.push(`static const size_t ${symbolPrefix}Size = ${buffer.length}ULL;`);
  }
  lines.push(`#endif`);
  return lines.join('\n') + '\n';
}

// 1. Ensure branding, fresh UI bundle, and Mod JAR exist
if (!fs.existsSync(path.join(ROOT, 'native/resources/vespera.ico'))) {
  execFileSync('node', ['scripts/generate-branding.mjs'], { stdio: 'inherit' });
}
console.log('[build-windows] Building fresh Vite UI bundle...');
execFileSync('npm', ['run', 'build:ui'], { stdio: 'inherit' });
const modJarPath = path.join(RELEASE_DIR, 'mods/vespera-client-1.2.1+mc1.21.4.jar');
if (!fs.existsSync(modJarPath)) {
  execFileSync('node', ['scripts/build-mod.mjs'], { stdio: 'inherit' });
}

// 1b. Resolve build-time Microsoft Entra public Client ID (zero secrets, zero fake IDs)
console.log('[build-windows] Resolving build-time OAuth public Client ID configuration...');
const oauthMetaJson = execFileSync(
  path.join(ROOT, 'node_modules/.bin/tsx'),
  [
    '-e',
    `import { resolveBuildTimeOAuthConfig } from './shared/oauthBuildConfig.ts';
     const cfg = resolveBuildTimeOAuthConfig();
     process.stdout.write(JSON.stringify(cfg));`,
  ],
  { encoding: 'utf8' }
);
const oauthMeta = JSON.parse(oauthMetaJson);
const embeddedOAuthHeader = [
  '#ifndef VESPERA_EMBEDDED_OAUTH_H',
  '#define VESPERA_EMBEDDED_OAUTH_H',
  `static const char* kEmbeddedMsaClientId = ${JSON.stringify(oauthMeta.clientId || '')};`,
  `static const char* kEmbeddedMsaConfigSource = ${JSON.stringify(oauthMeta.source || 'unconfigured')};`,
  '#endif',
  '',
].join('\n');
fs.writeFileSync(path.join(OBJ_DIR, 'embedded_oauth.h'), embeddedOAuthHeader);
console.log(
  `[build-windows] OAuth build config: configured=${oauthMeta.configured} (source=${oauthMeta.source})`
);

// 2. Inline dist/ui into a single self-contained HTML payload for WebView2
console.log('[build-windows] Bundling compiled UI assets into native C++ WebView2 header...');
const distUi = path.join(ROOT, 'dist/ui');
let html = fs.readFileSync(path.join(distUi, 'index.html'), 'utf8');
const assetsDir = path.join(distUi, 'assets');
const assetFiles = fs.readdirSync(assetsDir);
const cssFile = assetFiles.find((f) => f.endsWith('.css'));
const jsFile = assetFiles.find((f) => f.endsWith('.js'));

const markSvgB64 = fs.readFileSync(path.join(distUi, 'vespera-mark.svg')).toString('base64');
const markDataUri = `data:image/svg+xml;base64,${markSvgB64}`;

if (cssFile) {
  const cssText = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8');
  html = html.replace(/<link[^>]+stylesheet[^>]*>/i, `<style>${cssText}</style>`);
}
if (jsFile) {
  let jsText = fs.readFileSync(path.join(assetsDir, jsFile), 'utf8');
  jsText = jsText.replaceAll('./vespera-mark.svg', markDataUri);
  // Escape closing script tags safely
  const safeJs = jsText.replace(/<\/script>/gi, '<\\/script>');
  html = html.replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/i, () => `<script type="module">${safeJs}</script>`);
}
html = html.replaceAll('./vespera-mark.svg', markDataUri);

fs.writeFileSync(
  path.join(OBJ_DIR, 'embedded_ui.h'),
  toCByteArrayHeader('VESPERA_EMBEDDED_UI_H', 'kEmbeddedUiHtml', Buffer.from(html, 'utf8'), true)
);

// 3. Generate factory-default snapshot JSON directly from VesperaStateCoordinator
console.log('[build-windows] Generating synchronized default snapshot header...');
const tempDataDir = path.join(OBJ_DIR, 'seed-snapshot-tmp');
fs.rmSync(tempDataDir, { recursive: true, force: true });
const defaultJsonStr = execFileSync(
  path.join(ROOT, 'node_modules/.bin/tsx'),
  [
    '-e',
    `import fs from 'node:fs';
     import { VesperaStateCoordinator } from './server/stateStore.ts';
     const c = new VesperaStateCoordinator(${JSON.stringify(tempDataDir)});
     const snap = c.getSnapshot();
     if (fs.existsSync('./docs/BENCHMARK_LATEST.json')) {
       snap.latestBenchmark = JSON.parse(fs.readFileSync('./docs/BENCHMARK_LATEST.json', 'utf8'));
     }
     snap.recentLogs = ['[00:00:00] Vespera Client v1.2.1 Native Windows Engine Ready.'];
     c.shutdownCleanly();
     process.stdout.write(JSON.stringify(snap));`,
  ],
  { encoding: 'utf8' }
);
fs.rmSync(tempDataDir, { recursive: true, force: true });

fs.writeFileSync(
  path.join(OBJ_DIR, 'embedded_defaults.h'),
  toCByteArrayHeader(
    'VESPERA_EMBEDDED_DEFAULTS_H',
    'kDefaultSnapshotJson',
    Buffer.from(defaultJsonStr, 'utf8'),
    true
  )
);

// 4. Embed vespera-client-1.2.1+mc1.21.4.jar
const modJarBuf = fs.readFileSync(modJarPath);
fs.writeFileSync(
  path.join(OBJ_DIR, 'embedded_mod.h'),
  toCByteArrayHeader('VESPERA_EMBEDDED_MOD_H', 'kEmbeddedModJar', modJarBuf, false)
);

// 5. Compile Windows .rc resource files (icons + PerMonitorV2 DPI manifests + VERSIONINFO)
console.log('[build-windows] Compiling Windows .rc resource descriptors (vespera.ico + Win10/11 manifest)...');
const resDir = path.join(ROOT, 'native/resources');
for (const rcStem of ['launcher', 'uninstall', 'setup']) {
  execFileSync(
    ZIG_PY,
    ['-m', 'ziglang', 'rc', '--', `${rcStem}.rc`, path.join(OBJ_DIR, `${rcStem}.res`)],
    { cwd: resDir, stdio: 'inherit' }
  );
}

// 6. Compile VesperaClient.exe (64-bit Windows WebView2 Native GUI Launcher)
const launcherExePath = path.join(RELEASE_BIN_DIR, 'VesperaClient.exe');
console.log('[build-windows] Compiling VesperaClient.exe (x86_64-windows-gnu PE32+ GUI)...');
execFileSync(
  ZIG_PY,
  [
    '-m',
    'ziglang',
    'c++',
    '-std=c++17',
    '-target',
    'x86_64-windows-gnu',
    '-Os',
    '-Wl,--subsystem,windows',
    `-I${path.join(ROOT, 'native/third_party/webview/core/include')}`,
    `-I${path.join(ROOT, 'native/third_party/webview/compatibility/mingw/include')}`,
    `-I${path.join(ROOT, 'native/third_party/webview2')}`,
    `-I${path.join(ROOT, 'native/third_party')}`,
    `-I${OBJ_DIR}`,
    path.join(ROOT, 'native/third_party/webview/core/src/webview.cc'),
    path.join(ROOT, 'native/src/vespera_launcher.cpp'),
    path.join(OBJ_DIR, 'launcher.res'),
    '-lole32',
    '-loleaut32',
    '-luuid',
    '-lshlwapi',
    '-lversion',
    '-ladvapi32',
    '-lshell32',
    '-luser32',
    '-lgdi32',
    '-lcrypt32',
    '-lbcrypt',
    '-lwinhttp',
    '-lws2_32',
    '-lpsapi',
    '-o',
    launcherExePath,
  ],
  { stdio: 'inherit' }
);

// 7. Compile VesperaUninstall.exe (64-bit Windows Uninstaller)
const uninstallExePath = path.join(RELEASE_BIN_DIR, 'VesperaUninstall.exe');
console.log('[build-windows] Compiling VesperaUninstall.exe (x86_64-windows-gnu PE32+ GUI)...');
execFileSync(
  ZIG_PY,
  [
    '-m',
    'ziglang',
    'c++',
    '-std=c++17',
    '-target',
    'x86_64-windows-gnu',
    '-Os',
    '-Wl,--subsystem,windows',
    path.join(ROOT, 'native/installer/vespera_uninstall.cpp'),
    path.join(OBJ_DIR, 'uninstall.res'),
    '-lole32',
    '-luuid',
    '-ladvapi32',
    '-lshell32',
    '-luser32',
    '-lbcrypt',
    '-lcrypt32',
    '-lwinhttp',
    '-lws2_32',
    '-lpsapi',
    '-o',
    uninstallExePath,
  ],
  { stdio: 'inherit' }
);

// 8. Generate setup_payload.h with SHA-256 checksums and compile VesperaClient-1.2.1-win64-setup.exe
console.log('[build-windows] Packaging SHA-256 verified payload into VesperaClient-1.2.1-win64-setup.exe...');
const launcherBytes = fs.readFileSync(launcherExePath);
const uninstallBytes = fs.readFileSync(uninstallExePath);
const iconBytes = fs.readFileSync(path.join(resDir, 'vespera.ico'));
const licenseBytes = fs.readFileSync(path.join(ROOT, 'LICENSE'));

const launcherSha = crypto.createHash('sha256').update(launcherBytes).digest('hex');
const uninstallSha = crypto.createHash('sha256').update(uninstallBytes).digest('hex');

function rawBytesInitializer(buf) {
  const rows = [];
  for (let i = 0; i < buf.length; i += 28) {
    const s = buf.subarray(i, Math.min(i + 28, buf.length));
    rows.push('  ' + Array.from(s, (b) => `0x${b.toString(16).padStart(2, '0')}`).join(',') + ',');
  }
  return rows.join('\n');
}

const setupPayloadHeader = [
  '#ifndef VESPERA_SETUP_PAYLOAD_H',
  '#define VESPERA_SETUP_PAYLOAD_H',
  '#include <cstddef>',
  `static const char* kPayloadLauncherExeSha256 = "${launcherSha}";`,
  `static const size_t kPayloadLauncherExeSize = ${launcherBytes.length}ULL;`,
  `static const unsigned char kPayloadLauncherExe[${launcherBytes.length}] = {\n${rawBytesInitializer(launcherBytes)}\n};`,
  `static const char* kPayloadUninstallExeSha256 = "${uninstallSha}";`,
  `static const size_t kPayloadUninstallExeSize = ${uninstallBytes.length}ULL;`,
  `static const unsigned char kPayloadUninstallExe[${uninstallBytes.length}] = {\n${rawBytesInitializer(uninstallBytes)}\n};`,
  `static const size_t kPayloadIconIcoSize = ${iconBytes.length}ULL;`,
  `static const unsigned char kPayloadIconIco[${iconBytes.length}] = {\n${rawBytesInitializer(iconBytes)}\n};`,
  `static const size_t kPayloadModJarSize = ${modJarBuf.length}ULL;`,
  `static const unsigned char kPayloadModJar[${modJarBuf.length}] = {\n${rawBytesInitializer(modJarBuf)}\n};`,
  `static const unsigned char kPayloadLicenseRaw[${licenseBytes.length + 1}] = {\n${rawBytesInitializer(Buffer.concat([licenseBytes, Buffer.from([0])]))}\n};`,
  `static const char* kPayloadLicenseText = reinterpret_cast<const char*>(kPayloadLicenseRaw);`,
  '#endif',
  '',
].join('\n');

fs.writeFileSync(path.join(OBJ_DIR, 'setup_payload.h'), setupPayloadHeader);

for (const oldVer of ['1.0.0', '1.1.0', '1.1.1', '1.2.0']) {
  const oldSetup = path.join(RELEASE_DIR, `VesperaClient-${oldVer}-win64-setup.exe`);
  if (fs.existsSync(oldSetup)) fs.unlinkSync(oldSetup);
}

const setupExePath = path.join(RELEASE_DIR, 'VesperaClient-1.2.1-win64-setup.exe');
execFileSync(
  ZIG_PY,
  [
    '-m',
    'ziglang',
    'c++',
    '-std=c++17',
    '-target',
    'x86_64-windows-gnu',
    '-Os',
    '-Wl,--subsystem,windows',
    `-I${OBJ_DIR}`,
    path.join(ROOT, 'native/installer/vespera_setup.cpp'),
    path.join(OBJ_DIR, 'setup.res'),
    '-lcomctl32',
    '-lole32',
    '-luuid',
    '-ladvapi32',
    '-lshell32',
    '-luser32',
    '-lgdi32',
    '-lbcrypt',
    '-lcrypt32',
    '-lwinhttp',
    '-lws2_32',
    '-lpsapi',
    '-o',
    setupExePath,
  ],
  { stdio: 'inherit' }
);

// Copy application icon to release/ and write SHA256SUMS.txt
const releaseIconPath = path.join(RELEASE_DIR, 'vespera.ico');
fs.copyFileSync(path.join(resDir, 'vespera.ico'), releaseIconPath);

const setupSha = crypto.createHash('sha256').update(fs.readFileSync(setupExePath)).digest('hex');
const modSha = crypto.createHash('sha256').update(modJarBuf).digest('hex');
const iconSha = crypto.createHash('sha256').update(iconBytes).digest('hex');

const checksumLines = [
  `${setupSha}  VesperaClient-1.2.1-win64-setup.exe`,
  `${launcherSha}  bin/VesperaClient.exe`,
  `${uninstallSha}  bin/VesperaUninstall.exe`,
  `${modSha}  mods/vespera-client-1.2.1+mc1.21.4.jar`,
  `${iconSha}  vespera.ico`,
  '',
].join('\n');
fs.writeFileSync(path.join(RELEASE_DIR, 'SHA256SUMS.txt'), checksumLines);

console.log('\n[build-windows] Windows 10/11 x64 Release Build Succeeded:');
console.log(`  Setup Installer : ${setupExePath} (${(fs.statSync(setupExePath).size / 1024).toFixed(1)} KB)`);
console.log(`  Launcher Exe    : ${launcherExePath} (${(launcherBytes.length / 1024).toFixed(1)} KB)`);
console.log(`  Uninstaller Exe : ${uninstallExePath} (${(uninstallBytes.length / 1024).toFixed(1)} KB)`);
console.log(`  Fabric Mod JAR  : ${modJarPath} (${(modJarBuf.length / 1024).toFixed(1)} KB)`);
console.log(`  App Icon (.ico) : ${releaseIconPath} (${(iconBytes.length / 1024).toFixed(1)} KB)`);
