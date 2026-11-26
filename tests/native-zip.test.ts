import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = process.cwd();
const scratch = mkdtempSync(path.join(tmpdir(), 'vespera-native-zip-test-'));
const executable = path.join(scratch, process.platform === 'win32' ? 'native-zip-test.exe' : 'native-zip-test');
const compiler = process.env.CXX || (process.platform === 'win32' ? 'g++' : 'c++');
const cCompiler = process.env.CC || (process.platform === 'win32' ? 'gcc' : 'cc');
const available = spawnSync(compiler, ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(cCompiler, ['--version'], { stdio: 'ignore' }).status === 0;
const objDir = path.join(scratch, 'obj');
mkdirSync(objDir, { recursive: true });

function buildHarness() {
  for (const file of ['miniz.c', 'miniz_tinfl.c', 'miniz_tdef.c']) {
    execFileSync(cCompiler, ['-O2', '-I', path.join(root, 'native/third_party/miniz'), '-c',
      path.join(root, 'native/third_party/miniz', file), '-o', path.join(objDir, `${file}.o`)]);
  }
  execFileSync(compiler, ['-std=c++17', '-O2', '-I', path.join(root, 'native/src'),
    '-I', path.join(root, 'native/third_party/miniz'), path.join(root, 'tests/nativeZipHarness.cpp'),
    ...['miniz.c', 'miniz_tinfl.c', 'miniz_tdef.c'].map((file) => path.join(objDir, `${file}.o`)),
    '-o', executable]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipItem = { name: string; data: string; method?: 0 | 8; crcOverride?: number };
function makeZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const data = Buffer.from(item.data, 'utf8');
    const method = item.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = item.crcOverride ?? crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central); offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function invoke(zip: string, out: string, excludes: string[] = []) {
  return spawnSync(executable, [zip, out, ...excludes], { encoding: 'utf8' });
}
function zipFile(name: string, items: ZipItem[]) {
  const file = path.join(scratch, name);
  writeFileSync(file, makeZip(items));
  return file;
}
function output(name: string) {
  const dir = path.join(scratch, name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

const suite = available ? describe : describe.skip;
suite('native Minecraft ZIP/JAR extraction', () => {
  beforeAll(buildHarness);
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('extracts stored and deflated nested DLLs, preserving UTF-8 paths and applying exclusions', () => {
    const archive = zipFile('valid.jar', [
      { name: 'native/a.dll', data: 'alpha', method: 0 },
      { name: 'nested/βeta.dll', data: 'beta' },
      { name: 'META-INF/signature.dll', data: 'excluded' },
      { name: 'readme.txt', data: 'not a native' },
    ]);
    const dir = output('extract-valid');
    const result = invoke(archive, dir, ['META-INF/']);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(dir, 'a.dll'), 'utf8')).toBe('alpha');
    expect(readFileSync(path.join(dir, 'βeta.dll'), 'utf8')).toBe('beta');
    expect(existsSync(path.join(dir, 'META-INF/signature.dll'))).toBe(false);
  });

  it('rejects invalid CRC and truncated archives without damaging existing output', () => {
    const dir = output('recovery');
    mkdirSync(dir); writeFileSync(path.join(dir, 'keep.dll'), 'old-valid');
    const badCrc = zipFile('bad-crc.jar', [{ name: 'bad.dll', data: 'payload', crcOverride: 123 }]);
    const bad = invoke(badCrc, dir);
    expect(bad.status).not.toBe(0); expect(bad.stderr).toMatch(/CRC-32/);
    const truncatedFile = path.join(scratch, 'truncated.jar');
    writeFileSync(truncatedFile, makeZip([{ name: 'a.dll', data: 'abc' }]).subarray(0, 19));
    expect(invoke(truncatedFile, dir).status).not.toBe(0);
    expect(readFileSync(path.join(dir, 'keep.dll'), 'utf8')).toBe('old-valid');
    expect(existsSync(path.join(dir, 'bad.dll'))).toBe(false);
  });

  it('rejects missing files and path traversal', () => {
    const missing = invoke(path.join(scratch, 'does-not-exist.jar'), output('missing'));
    expect(missing.status).not.toBe(0);
    const traversal = zipFile('traversal.jar', [{ name: '../escape.dll', data: 'nope' }]);
    const dir = output('traversal');
    expect(invoke(traversal, dir).status).not.toBe(0);
    expect(existsSync(path.join(scratch, 'escape.dll'))).toBe(false);
  });

  it('handles exact duplicate entries and repeated extraction idempotently, rejects conflicting duplicate names', () => {
    const dir = output('duplicates');
    const same = zipFile('same.jar', [
      { name: 'same.dll', data: 'identical' }, { name: 'same.dll', data: 'identical' },
    ]);
    expect(invoke(same, dir).status).toBe(0);
    expect(invoke(same, dir).status).toBe(0);
    const conflict = zipFile('conflict.jar', [
      { name: 'dup.dll', data: 'first' }, { name: 'dup.dll', data: 'second' },
    ]);
    expect(invoke(conflict, output('conflict')).status).not.toBe(0);
    const caseConflict = zipFile('case-conflict.jar', [
      { name: 'Case.dll', data: 'upper' }, { name: 'case.DLL', data: 'lower' },
    ]);
    expect(invoke(caseConflict, output('case-conflict')).status).not.toBe(0);
  });

  it('selects only Windows native classifiers matching the launcher architecture', () => {
    const match = (classifier: string, arch: string) => spawnSync(executable, ['--classifier', classifier, arch]).status === 0;
    expect(match('natives-windows', '64')).toBe(true);
    expect(match('natives-windows-x86_64', '64')).toBe(true);
    expect(match('natives-windows-x86', '64')).toBe(false);
    expect(match('natives-windows-arm64', '64')).toBe(false);
    expect(match('natives-windows-x86', '32')).toBe(true);
    expect(match('natives-windows', '32')).toBe(false);
  });

  it('merges multiple classifier archives safely and preserves recovered output after an interrupted archive', () => {
    const dir = output('classifiers');
    const one = zipFile('windows-x64.jar', [{ name: 'x64.dll', data: 'x64' }]);
    const two = zipFile('platform-extra.jar', [{ name: 'extra.dll', data: 'extra' }]);
    expect(invoke(one, dir).status).toBe(0);
    expect(invoke(two, dir).status).toBe(0);
    expect(readFileSync(path.join(dir, 'x64.dll'), 'utf8')).toBe('x64');
    expect(readFileSync(path.join(dir, 'extra.dll'), 'utf8')).toBe('extra');
    const interrupted = path.join(scratch, 'interrupted.jar');
    writeFileSync(interrupted, makeZip([{ name: 'partial.dll', data: 'partial' }]).subarray(0, 45));
    expect(invoke(interrupted, dir).status).not.toBe(0);
    expect(existsSync(path.join(dir, 'partial.dll'))).toBe(false);
    expect(readFileSync(path.join(dir, 'x64.dll'), 'utf8')).toBe('x64');
  });
});
