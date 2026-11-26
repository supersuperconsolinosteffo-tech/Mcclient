import fs from 'node:fs';
import path from 'node:path';

export interface ResolvedOAuthBuildConfig {
  clientId: string;
  configured: boolean;
  source: 'env_override' | 'developer_local' | 'release_config' | 'unconfigured';
  tenant: 'consumers' | 'common';
  scopes: string[];
  loopbackRedirectPath: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a candidate public Microsoft Entra Application (client) ID is a genuine UUID
 * and rejects placeholder strings (such as all-zeros) or accidentally supplied client secrets.
 */
export function isValidMicrosoftPublicClientId(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(trimmed)) return false;
  return UUID_REGEX.test(trimmed);
}

/**
 * Resolves the build-time Microsoft OAuth 2.0 public Client ID from:
 *   1. `VESPERA_MSA_CLIENT_ID` environment variable (CI / maintainer release pipeline)
 *   2. `config/oauth.local.json` (gitignored local developer configuration)
 *   3. `config/oauth.release.json` (maintainer repository release configuration)
 *
 * Security invariant: Refuses to run if `VESPERA_MSA_CLIENT_SECRET` or a `clientSecret` property
 * is supplied, ensuring a secret is never embedded into a desktop build.
 */
export function resolveBuildTimeOAuthConfig(projectRoot = process.cwd()): ResolvedOAuthBuildConfig {
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
    loopbackRedirectPath: '/callback',
  };

  const readConfigFile = (relPath: string): { clientId?: string; tenant?: string } | null => {
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
    };
  };

  const releaseCfg = readConfigFile('config/oauth.release.json');
  const localCfg = readConfigFile('config/oauth.local.json');
  const envClientId = (process.env.VESPERA_MSA_CLIENT_ID || '').trim();

  if (envClientId) {
    if (!isValidMicrosoftPublicClientId(envClientId)) {
      throw new Error(
        `Invalid VESPERA_MSA_CLIENT_ID "${envClientId}": expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return { ...base, clientId: envClientId, configured: true, source: 'env_override' };
  }

  if (localCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(localCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.local.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return {
      ...base,
      clientId: localCfg.clientId,
      configured: true,
      source: 'developer_local',
      tenant: localCfg.tenant === 'common' ? 'common' : 'consumers',
    };
  }

  if (releaseCfg?.clientId) {
    if (!isValidMicrosoftPublicClientId(releaseCfg.clientId)) {
      throw new Error(
        `Invalid clientId in config/oauth.release.json: expected a registered Microsoft Entra Application (client) UUID.`
      );
    }
    return {
      ...base,
      clientId: releaseCfg.clientId,
      configured: true,
      source: 'release_config',
      tenant: releaseCfg.tenant === 'common' ? 'common' : 'consumers',
    };
  }

  return base;
}
