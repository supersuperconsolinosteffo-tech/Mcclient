import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Prevents path traversal attacks when handling profile imports, mod filenames, or custom directories.
 */
export function resolveSafeChildPath(baseDir: string, relativeTarget: string): string {
  const resolvedBase = path.resolve(baseDir);
  const sanitizedRel = relativeTarget.replace(/\0/g, '');
  const resolvedTarget = path.resolve(resolvedBase, sanitizedRel);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Security violation: path "${relativeTarget}" escapes managed directory "${resolvedBase}".`);
  }
  return resolvedTarget;
}

/**
 * Validates that a file name contains no directory separators or reserved Windows device names.
 */
export function validateSafeFileName(fileName: string): boolean {
  if (!fileName || fileName.length > 200) return false;
  if (/[/\\:\0<>|?*]/.test(fileName)) return false;
  if (fileName === '.' || fileName === '..') return false;
  const stem = fileName.split('.')[0].toUpperCase();
  const reserved = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);
  return !reserved.has(stem);
}

/**
 * Scrubs OAuth access tokens, refresh tokens, Bearer headers, and Minecraft session tokens from logs.
 */
export function redactSensitiveTokens(logLine: string): string {
  return logLine
    .replace(/(--accessToken\s+)([^\s"']+)/gi, '$1[REDACTED_MC_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_BEARER]')
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/(M\.C[0-9a-zA-Z._-]{20,})/g, '[REDACTED_MSA_TOKEN]');
}

/**
 * Computes cryptographic file digest (sha1, sha256, or sha512).
 */
export function computeFileHashSync(filePath: string, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha256'): string {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

/**
 * Writes JSON or text atomically using write-temp -> fsync -> rename to prevent corruption on crash/power loss.
 */
export function writeFileAtomicSync(targetPath: string, content: string | Buffer): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    if (typeof content === 'string') {
      fs.writeFileSync(fd, content, 'utf8');
    } else {
      fs.writeFileSync(fd, content);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Encrypted local credential vault using AES-256-GCM (paired with Win32 CryptProtectData DPAPI in VesperaClient.exe).
 * Never stores passwords; encrypts OAuth refresh/access tokens at rest with mode 0600 permissions.
 */
export class EncryptedTokenVault {
  private readonly vaultPath: string;
  private readonly derivedKey: Buffer;

  constructor(vaultDir: string, machineSaltOverride?: string) {
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    this.vaultPath = path.join(vaultDir, 'accounts.vault.bin');
    const hostIdentity = machineSaltOverride ?? `${os.userInfo().username}@${os.hostname()}::vespera-vault-v1`;
    this.derivedKey = crypto.pbkdf2Sync(hostIdentity, 'vespera-client-dpapi-bridge-salt', 120_000, 32, 'sha512');
  }

  saveEncrypted(payload: unknown): void {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.derivedKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = Buffer.concat([Buffer.from('VSP1', 'ascii'), iv, authTag, encrypted]);
    writeFileAtomicSync(this.vaultPath, envelope);
  }

  loadDecrypted<T>(fallback: T): T {
    if (!fs.existsSync(this.vaultPath)) return fallback;
    try {
      const envelope = fs.readFileSync(this.vaultPath);
      if (envelope.length < 32 || envelope.subarray(0, 4).toString('ascii') !== 'VSP1') {
        return fallback;
      }
      const iv = envelope.subarray(4, 16);
      const authTag = envelope.subarray(16, 32);
      const ciphertext = envelope.subarray(32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.derivedKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8')) as T;
    } catch {
      return fallback;
    }
  }
}
