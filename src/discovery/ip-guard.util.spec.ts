import { isBlockedIp } from './ip-guard.util';

describe('isBlockedIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12 lower bound'],
    ['172.31.255.255', 'private 172.16/12 upper bound'],
    ['192.168.1.1', 'private 192.168/16'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['0.0.0.0', 'this network'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['240.0.0.1', 'reserved'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fc00::1', 'IPv6 unique local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public DNS'],
    ['93.184.216.34', 'public host'],
    ['172.15.255.255', 'just below the private 172.16/12 range'],
    ['172.32.0.0', 'just above the private 172.16/12 range'],
    ['2606:4700:4700::1111', 'public IPv6'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('fails closed on an unrecognizable value', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});
