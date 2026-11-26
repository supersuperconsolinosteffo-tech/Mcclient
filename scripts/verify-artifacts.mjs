import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function assert(cond, msg) {
  if (!cond) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
  }
  console.log(`[PASS] ${msg}`);
}

function verifyPe64GuiExecutable(filePath, label) {
  assert(fs.existsSync(filePath), `${label} exists at ${filePath}`);
  const buf = fs.readFileSync(filePath);
  assert(buf.length > 64 * 1024, `${label} is non-trivial (${(buf.length / 1024).toFixed(1)} KB)`);

  // 1. DOS Header 'MZ'
  assert(buf[0] === 0x4d && buf[1] === 0x5a, `${label} has valid DOS 'MZ' magic`);
  const peOffset = buf.readUInt32LE(0x3c);
  assert(peOffset > 0 && peOffset + 264 < buf.length, `${label} has valid e_lfanew PE header offset (${peOffset})`);

  // 2. PE\0\0 Signature
  const peSig = buf.subarray(peOffset, peOffset + 4).toString('ascii');
  assert(peSig === 'PE\0\0', `${label} has valid 'PE\\0\\0' signature`);

  // 3. COFF Machine = 0x8664 (IMAGE_FILE_MACHINE_AMD64)
  const machine = buf.readUInt16LE(peOffset + 4);
  const numSections = buf.readUInt16LE(peOffset + 6);
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20);
  assert(machine === 0x8664, `${label} targets 64-bit x86_64 Windows (machine=0x${machine.toString(16)})`);

  // 4. Optional Header Magic = 0x020B (PE32+) & Subsystem = 2 (IMAGE_SUBSYSTEM_WINDOWS_GUI)
  const optOffset = peOffset + 24;
  const optMagic = buf.readUInt16LE(optOffset);
  const subsystem = buf.readUInt16LE(optOffset + 68);
  assert(optMagic === 0x020b, `${label} uses PE32+ 64-bit Optional Header (0x${optMagic.toString(16)})`);
  assert(subsystem === 2, `${label} uses native Windows GUI subsystem (subsystem=${subsystem})`);

  // 5. Verify .rsrc resource section exists (embeds vespera.ico, PerMonitorV2 DPI manifest, and VERSIONINFO)
  const sectionTableOffset = optOffset + sizeOfOptionalHeader;
  const sectionNames = [];
  for (let i = 0; i < numSections; i++) {
    const secOff = sectionTableOffset + i * 40;
    const rawName = buf.subarray(secOff, secOff + 8).toString('ascii').replace(/\0+$/, '');
    sectionNames.push(rawName);
  }
  assert(
    sectionNames.includes('.rsrc'),
    `${label} contains embedded Windows '.rsrc' resource table (sections: ${sectionNames.join(', ')})`
  );
}

console.log('=== Verifying Vespera Client Final Release Artifacts ===');

const setupExe = path.join(ROOT, 'release/VesperaClient-1.0.0-win64-setup.exe');
const launcherExe = path.join(ROOT, 'release/bin/VesperaClient.exe');
const uninstallExe = path.join(ROOT, 'release/bin/VesperaUninstall.exe');
const modJar = path.join(ROOT, 'release/mods/vespera-client-1.0.0+mc1.21.4.jar');
const iconIco = path.join(ROOT, 'release/vespera.ico');
const sumsFile = path.join(ROOT, 'release/SHA256SUMS.txt');

verifyPe64GuiExecutable(setupExe, 'Windows 64-bit Setup Installer (VesperaClient-1.0.0-win64-setup.exe)');
verifyPe64GuiExecutable(launcherExe, 'Windows 64-bit Desktop Launcher (VesperaClient.exe)');
verifyPe64GuiExecutable(uninstallExe, 'Windows 64-bit Uninstaller (VesperaUninstall.exe)');

assert(fs.existsSync(iconIco), `Multi-resolution Windows icon exists at ${iconIco}`);
const icoHeader = fs.readFileSync(iconIco);
assert(
  icoHeader.readUInt16LE(0) === 0 && icoHeader.readUInt16LE(2) === 1 && icoHeader.readUInt16LE(4) === 7,
  'vespera.ico has valid ICO directory header with 7 embedded DPI resolutions (16..256px)'
);

assert(fs.existsSync(modJar), `Compiled Fabric Client Mod JAR exists at ${modJar}`);
const zipList = execFileSync('unzip', ['-l', modJar], { encoding: 'utf8' });
assert(zipList.includes('fabric.mod.json'), 'Mod JAR includes fabric.mod.json');
assert(zipList.includes('vespera.mixins.json'), 'Mod JAR includes vespera.mixins.json');
assert(zipList.includes('gg/vespera/client/VesperaClientMod.class'), 'Mod JAR includes compiled VesperaClientMod.class');
assert(zipList.includes('assets/vespera/icon.png'), 'Mod JAR includes custom Mod Menu icon');
assert(!zipList.includes('net/fabricmc/api/ClientModInitializer.class'), 'Mod JAR excludes compile-only stub classes');

// Verify C++ native launcher diagnostics contract (must assign DiagnosticFinding[] array, never object wrapper)
const cppSource = fs.readFileSync(path.join(ROOT, 'native/src/vespera_launcher.cpp'), 'utf8');
assert(
  cppSource.includes('state["diagnostics"] = findings;') && !cppSource.includes('"overallHealth"'),
  'Native C++ launcher emits DiagnosticFinding[] array contract for state["diagnostics"]'
);

// Verify SHA256SUMS.txt
assert(fs.existsSync(sumsFile), 'SHA256SUMS.txt exists in release/');
for (const line of fs.readFileSync(sumsFile, 'utf8').trim().split('\n')) {
  const [expectedHash, relFile] = line.trim().split(/\s+/);
  const actualHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'release', relFile)))
    .digest('hex');
  assert(actualHash === expectedHash, `SHA-256 verified for release/${relFile}`);
}

console.log('=== All Release Deliverables & Binary Signatures Verified Clean ===');
