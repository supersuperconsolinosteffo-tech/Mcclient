import fs from 'node:fs';
import path from 'node:path';

export type OAuthConfigSource =
  | 'env_override'
  | 'developer_local'
  | 'development_config'
  | 'release_config'
  | 'unconfigured';

export interface ResolvedOAuthBuildConfig {
  clientId: string;
  configured: boolean;
  source: OAuthConfigSource;
  tenant: 'consumers' | 'common';
  scopes: string[];
  loopbackHost: 'localhost' | '127.0.0.1';
  loopbackRedirectPath: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a candidate public Microsoft Entra Application (client) ID is a genuine UUID
 * and rejects placeholder strings (such as all-zeros) or malformed values.
 */
export function isValidMicrosoftPublicClientId(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(trimmed)) return false;
  return UUID_REGEX.test(trimmed);
}

interface RawOAuthConfigFile {
  clientId?: string;
  tenant?: string;
  loopbackHost?: string;
  loopbackRedirectPath?: string;
}

/**
 * Resolves the build-time Microsoft Identity Platform OAuth 2.0 public Client ID from:
 *   1. `VESPERA_MSA_CLIENT_ID` environment variable (CI / release pipeline / shell override)
 *   2. `config/oauth.local.json` (gitignored local developer configuration)
 *   3. `config/oauth.development.json` (when `NODE_ENV === 'development'`)
 *   4. `config/oauth.release.json` (production release configuration)
 *
 * Security invariant: Refuses to run if `VESPERA_MSA_CLIENT_SECRET` or a `clientSecret` property
 * is supplied, ensuring a secret is never embedded into a desktop build.
 * Default redirect URI format is `http://localhost:<port>` (RFC 8252 native desktop loopback),
 * matching the standard `http://localhost` Mobile & Desktop registration in Microsoft Entra ID.
 */
export function resolveBuildTimeOAuthConfig(
  projectRoot = process.cwd(),
  mode: 'development' | 'production' = process.env.NODE_ENV === 'development'
    ? 'development'
    : 'production'
): ResolvedOAuthBuildConfig {
  if (process.env.VESPERA_MSA_CLIENT_SECRET) {
    throw new Error(
      'Security Violation: VESPERA_MSA_CLIENT_SECRET detected. Desktop public-client builds must NEVER embed a Microsoft Client Secret.'
    );
  }

  const base: ResolvedOAuthBuildConfig = {
    clientId: '',
    configured: false,
    source: 'unconfigured',
    tenant: 'consumers',
    scopes: ['XboxLive.signin', 'offline_access'],
    loopbackHost: 'localhost',
    loopbackRedirectPath: '',
  };

  const readConfigFile = (relPath: string): RawOAuthConfigFile | null => {
    const full = path.join(projectRoot, relPath);
    if (!fs.existsSync(full)) return null;
    const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
    if (typeof raw.clientSecret === 'string' && raw.clientSecret.trim().length > 0) {
      throw new Error(
        `Security Violation: "${relPath}" contains a "clientSecret" field. Native desktop apps must use OAuth 2.0 PKCE public client authentication without secrets.`
      );
    }
    return {
      clientId: typeof raw.clientId === 'string' ? raw.clientId.trim() : '',
      tenant: typeof raw.tenant === 'string' ? raw.tenant : undefined,
      loopbackHost: typeof raw.loopbackHost === 'string' ? raw.loopbackHost : undefined,
      loopbackRedirectPath:
        typeof raw.loopbackRedirectPath === 'string' ? raw.loopbackRedirectPath : undefined,
    };
  };

  const applyOverrides = (
    cfg: RawOAuthConfigFile | null,
    clientId: string,
    source: OAuthConfigSource
  ): ResolvedOAuthBuildConfig => {
    const normalizedPath =
      cfg?.loopbackRedirectPath && cfg.loopbackRedirectPath.trim().length > 0
        ? cfg.loopbackRedirectPath.startsWith('/')
          ? cfg.loopbackRedirectPath.trim()
          : `/${cfg.loopbackRedirectPath.trim()}`
        : '';
    return {
      ...base,
      clientId,
      configured: true,
      source,
      tenant: cfg?.tenant === 'common' ? 'common' : 'consumers',
      loopbackHost: cfg?.loopbackHost === '127.0.0.1' ? '127.0.0.1' : 'localhost',
      loopbackRedirectPath: normalizedPath,
    };
  };

  const releaseCfg = readConfigFile('config/oauth.release.json');
  const devCfg = readConfigFile('config/oauth.development.json');
  const localCfg = readConfigFile('config/oauth.local.json');
  const envClientId = (process.env.VESPERA_MSA_CLIENT_ID || '').trim();

  if (envClientId) {
    if (!isValidMicrosoftPublicClientId(envClientId)) {
      throw new Error(
        `Invalid VESPERA_MSA_CLIENT_ID "${envClientId}": expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return applyOverrides(localCfg ?? releaseCfg, envClientId, 'env_override');
  }

  if (localCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(localCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.local.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return applyOverrides(localCfg, localCfg.clientId, 'developer_local');
  }

  if (mode === 'development' && devCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(devCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.development.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return applyOverrides(devCfg, devCfg.clientId, 'development_config');
  }

  if (releaseCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(releaseCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.release.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return applyOverrides(releaseCfg, releaseCfg.clientId, 'release_config');
  }

  if (devCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(devCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.development.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return applyOverrides(devCfg, devCfg.clientId, 'development_config');
  }

  return base;
}
