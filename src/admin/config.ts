import { isIP } from 'node:net';

export interface AdminSettings {
  origin: string;
  secureCookies: boolean;
  cookieName: string;
  trustProxy: false | string[];
}

export function adminSettings(environment: NodeJS.ProcessEnv = process.env): AdminSettings {
  const production = environment.NODE_ENV === 'production';
  const url = new URL(environment.PUBLIC_ORIGIN ?? (production ? 'https://localhost' : `http://127.0.0.1:${environment.PORT ?? 3000}`));
  if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, a path, a query or a fragment.');
  }
  const secureCookies = url.protocol === 'https:';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!secureCookies && (!loopback || (production && environment.ALLOW_INSECURE_LOCAL_ADMIN !== 'true'))) {
    throw new Error('HTTP admin access is allowed only on localhost in development or with ALLOW_INSECURE_LOCAL_ADMIN=true.');
  }
  const proxies = (environment.TRUSTED_PROXY_CIDRS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const proxy of proxies) {
    const [address, prefix, ...extra] = proxy.split('/');
    const family = isIP(address ?? '');
    if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or CIDRs; blanket trust is not allowed.');
    }
  }
  return {
    origin: url.origin,
    secureCookies,
    cookieName: secureCookies ? '__Host-osrs-jokes-admin' : 'osrs-jokes-admin-local',
    trustProxy: proxies.length ? proxies : false,
  };
}
