import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JAVA_HOME = path.join(ROOT, '.venv/lib/python3.11/site-packages/jdk4py/java-runtime');
const KOTLINC = path.join(ROOT, 'node_modules/kotlin-compiler/bin/kotlinc');

function walkFiles(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (!ext || full.endsWith(ext)) out.push(full);
  }
  return out;
}

const buildRoot = path.join(ROOT, 'mod/build/local-compile');
const stubsOut = path.join(buildRoot, 'stubs-classes');
const modClassesOut = path.join(buildRoot, 'mod-classes');
const releaseModsDir = path.join(ROOT, 'release/mods');
const distBenchDir = path.join(ROOT, 'dist/bench');

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(stubsOut, { recursive: true });
fs.mkdirSync(modClassesOut, { recursive: true });
fs.mkdirSync(releaseModsDir, { recursive: true });
fs.mkdirSync(distBenchDir, { recursive: true });

const env = {
  ...process.env,
  JAVA_HOME,
  PATH: `${path.join(JAVA_HOME, 'bin')}:${process.env.PATH}`,
};

console.log('[build-mod] Compiling Fabric/Mixin compile-only API descriptors...');
const stubSources = walkFiles(path.join(ROOT, 'mod/compile-stubs'), '.kt');
execFileSync(KOTLINC, ['-jvm-target', '21', ...stubSources, '-d', stubsOut], {
  env,
  stdio: 'inherit',
});

console.log('[build-mod] Compiling Vespera Client Fabric Mod (Kotlin -> JVM 21)...');
const mainSources = walkFiles(path.join(ROOT, 'mod/src/main/kotlin'), '.kt');
execFileSync(
  KOTLINC,
  ['-jvm-target', '21', '-cp', stubsOut, ...mainSources, '-d', modClassesOut],
  { env, stdio: 'inherit' }
);

// Copy resources (fabric.mod.json, vespera.mixins.json, assets/vespera/*) into modClassesOut
const resourcesDir = path.join(ROOT, 'mod/src/main/resources');
fs.cpSync(resourcesDir, modClassesOut, { recursive: true });

const manifestDir = path.join(modClassesOut, 'META-INF');
fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(
  path.join(manifestDir, 'MANIFEST.MF'),
  [
    'Manifest-Version: 1.0',
    'Implementation-Title: Vespera Client Core Fabric Mod',
    'Implementation-Version: 1.1.0+mc1.21.4',
    'Implementation-Vendor: Vespera Labs',
    'Fabric-Loom-Mixin-Remap-Type: static',
    '',
  ].join('\r\n')
);

const modJarPath = path.join(releaseModsDir, 'vespera-client-1.1.0+mc1.21.4.jar');
if (fs.existsSync(modJarPath)) fs.unlinkSync(modJarPath);
const legacyJarPath = path.join(releaseModsDir, 'vespera-client-1.0.0+mc1.21.4.jar');
if (fs.existsSync(legacyJarPath)) fs.unlinkSync(legacyJarPath);
const legacyShaPath = path.join(releaseModsDir, 'vespera-client-1.0.0+mc1.21.4.jar.sha256');
if (fs.existsSync(legacyShaPath)) fs.unlinkSync(legacyShaPath);

execFileSync('zip', ['-rq', modJarPath, '.'], { cwd: modClassesOut, stdio: 'inherit' });

// Also compile standalone benchmark runner JAR (includes Kotlin runtime so OpenJDK 21 runs it directly)
const benchJarPath = path.join(distBenchDir, 'vespera-benchmark-runner.jar');
execFileSync(
  KOTLINC,
  [
    '-jvm-target',
    '21',
    '-include-runtime',
    path.join(ROOT, 'mod/src/main/kotlin/gg/vespera/client/core/RingBufferMetrics.kt'),
    path.join(ROOT, 'mod/src/main/kotlin/gg/vespera/client/benchmark/VesperaJvmBenchmarkHarness.kt'),
    '-d',
    benchJarPath,
  ],
  { env, stdio: 'inherit' }
);

const jarBytes = fs.readFileSync(modJarPath);
const sha256 = crypto.createHash('sha256').update(jarBytes).digest('hex');
fs.writeFileSync(
  path.join(releaseModsDir, 'vespera-client-1.1.0+mc1.21.4.jar.sha256'),
  `${sha256}  vespera-client-1.1.0+mc1.21.4.jar\n`
);

console.log(
  `[build-mod] Built ${modJarPath} (${(jarBytes.length / 1024).toFixed(1)} KB, SHA-256: ${sha256.slice(0, 16)}...)`
);
