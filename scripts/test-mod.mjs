import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const JAVA_HOME = path.join(ROOT, '.venv/lib/python3.11/site-packages/jdk4py/java-runtime');
const JAVA = path.join(JAVA_HOME, 'bin/java');
const KOTLINC = path.join(ROOT, 'node_modules/kotlin-compiler/bin/kotlinc');

const modJarPath = path.join(ROOT, 'release/mods/vespera-client-1.2.1+mc1.21.4.jar');
const stubsOut = path.join(ROOT, 'mod/build/local-compile/stubs-classes');
const testJarPath = path.join(ROOT, 'mod/build/local-compile/vespera-mod-tests.jar');

if (!fs.existsSync(modJarPath)) {
  execFileSync('node', ['scripts/build-mod.mjs'], { stdio: 'inherit' });
}

const env = {
  ...process.env,
  JAVA_HOME,
  PATH: `${path.join(JAVA_HOME, 'bin')}:${process.env.PATH}`,
};

console.log('[test-mod] Compiling VesperaModTestSuite.kt...');
execFileSync(
  KOTLINC,
  [
    '-jvm-target',
    '21',
    '-include-runtime',
    '-cp',
    `${modJarPath}:${stubsOut}`,
    path.join(ROOT, 'mod/src/test/kotlin/gg/vespera/client/VesperaModTestSuite.kt'),
    '-d',
    testJarPath,
  ],
  { env, stdio: 'inherit' }
);

console.log('[test-mod] Executing tests on Eclipse Temurin OpenJDK 21...');
execFileSync(
  JAVA,
  ['-cp', `${testJarPath}:${modJarPath}:${stubsOut}`, 'gg.vespera.client.VesperaModTestSuite'],
  { env, stdio: 'inherit' }
);
