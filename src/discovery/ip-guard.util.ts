import { isIPv4, isIPv6 } from 'net';

// SSRF core defense — blocks loopback/private/link-local/reserved ranges for
// both IPv4 and IPv6, including the cloud-metadata endpoint (169.254.169.254
// falls under the IPv4 link-local block below). Anything not recognizable as
// a valid IP fails closed (treated as blocked).
export function isBlockedIp(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 0) return true; // "this network"
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }

  if (isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local fe80::/10
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]); // IPv4-mapped IPv6 — check the embedded address
    return false;
  }

  return true; // not a recognizable IP — fail closed
}
