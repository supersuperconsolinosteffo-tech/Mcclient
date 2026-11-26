import type { MultiplayerRejectionNotice } from './types';

export interface UsernameValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

const MC_USERNAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Validates a Minecraft: Java Edition username according to official Mojang format rules:
 * - 3 to 16 characters
 * - ASCII letters (A-Z, a-z), digits (0-9), and underscores (_) only
 */
export function validateMinecraftUsername(rawInput: string): UsernameValidationResult {
  const normalized = (rawInput ?? '').trim();
  if (!normalized) {
    return {
      valid: false,
      normalized: '',
      error: 'Please enter a Minecraft username (3–16 characters).',
    };
  }
  if (normalized.length < 3) {
    return {
      valid: false,
      normalized,
      error: 'Minecraft usernames must be at least 3 characters long.',
    };
  }
  if (normalized.length > 16) {
    return {
      valid: false,
      normalized,
      error: 'Minecraft usernames cannot exceed 16 characters.',
    };
  }
  if (!MC_USERNAME_REGEX.test(normalized)) {
    return {
      valid: false,
      normalized,
      error:
        'Minecraft usernames may only contain letters (A–Z), numbers (0–9), and underscores (_).',
    };
  }
  return { valid: true, normalized };
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
);

function md5BytesUtf8(input: string): Uint8Array {
  const utf8 = new TextEncoder().encode(input);
  const bitLenLo = (utf8.length * 8) >>> 0;
  const bitLenHi = Math.floor((utf8.length * 8) / 0x100000000) >>> 0;
  const padLen = ((56 - ((utf8.length + 1) % 64)) + 64) % 64;
  const totalLen = utf8.length + 1 + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(utf8, 0);
  buf[utf8.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, bitLenLo, true);
  dv.setUint32(totalLen - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < totalLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const m = dv.getUint32(offset + g * 4, true);
      const sum = (a + f + MD5_K[i] + m) >>> 0;
      const s = MD5_S[i];
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(0, a0, true);
  outDv.setUint32(4, b0, true);
  outDv.setUint32(8, c0, true);
  outDv.setUint32(12, d0, true);
  return out;
}

/**
 * Generates the exact deterministic Minecraft Java offline-mode UUID matching
 * `java.util.UUID.nameUUIDFromBytes(("OfflinePlayer:" + username).getBytes(StandardCharsets.UTF_8))`
 * (RFC 4122 Version 3 MD5 namespace hash).
 *
 * Pure TypeScript / Web-safe so both the browser UI and Node backend compute identical UUIDs.
 */
export function generateOfflineMinecraftUuid(username: string): string {
  const md5 = md5BytesUtf8(`OfflinePlayer:${username}`);

  // Set version to 3 (name-based MD5): clear top nibble of byte 6, set 0x30
  md5[6] = (md5[6] & 0x0f) | 0x30;
  // Set RFC 4122 IETF variant (10xxxxxx): clear top 2 bits of byte 8, set 0x80
  md5[8] = (md5[8] & 0x3f) | 0x80;

  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += md5[i].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Strips hyphens from a dashed UUID when passing `--uuid` to Mojang argument templates.
 */
export function stripUuidHyphens(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

const ONLINE_MODE_REJECTION_PATTERNS: RegExp[] = [
  /Failed to login:\s*Invalid session/i,
  /Failed to verify username/i,
  /multiplayer\.disconnect\.unverified_username/i,
  /Not authenticated with Minecraft\.net/i,
  /Failed to login:\s*The authentication servers/i,
  /disconnect\.loginFailedInfo\.invalidSession/i,
];

/**
 * Inspects Minecraft client log output or server disconnect text and detects when a server
 * rejects a connection due to online-mode authentication requirements.
 */
export function classifyMultiplayerServerRejection(
  logText: string,
  accountType: 'offline' | 'microsoft',
  username?: string
): MultiplayerRejectionNotice | null {
  if (!logText) return null;
  const matched = ONLINE_MODE_REJECTION_PATTERNS.some((re) => re.test(logText));
  if (!matched) return null;

  if (accountType === 'offline') {
    return {
      timestamp: new Date().toISOString(),
      accountType: 'offline',
      username: username || 'Offline Player',
      reasonCode: 'online_mode_required',
      title: 'Server Requires an Authenticated Microsoft Account',
      message:
        'This multiplayer server has online-mode enabled and requires official Microsoft authentication. Offline accounts work for Singleplayer, LAN sessions, and servers configured with online-mode=false. Switch to or sign in with a Microsoft Account in the Accounts tab to join online-mode servers.',
    };
  }

  return {
    timestamp: new Date().toISOString(),
    accountType: 'microsoft',
    username: username || 'Player',
    reasonCode: 'microsoft_session_expired',
    title: 'Minecraft Online Session Needs Refresh',
    message:
      'The server rejected your current session token because it expired or was superseded. Open the Accounts tab and click Refresh (or Sign in with Microsoft) to renew your online session.',
  };
}
