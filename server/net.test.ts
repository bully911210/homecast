import { describe, expect, it } from 'vitest';
import { hostOf, isAllowedHost, isLanAddress, isLoopback, isSameOrigin, lanAdapters } from './net.ts';
import type { NetworkInterfaceInfo } from 'node:os';

describe('LAN guard', () => {
  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:192.168.1.20', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.10', true],
    ['169.254.10.10', true],
    ['fd12:3456::1', true],
    ['fe80::1%eth0', true],
    ['172.32.0.1', false],
    ['172.15.255.255', false],
    ['8.8.8.8', false],
    ['100.64.0.1', false],
    ['2001:4860:4860::8888', false],
    ['::ffff:8.8.8.8', false],
    ['', false],
    ['not-an-ip', false],
  ])('%s -> %s', (ip, want) => expect(isLanAddress(ip)).toBe(want));

  it('loopback', () => {
    expect(isLoopback('127.5.5.5')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.2')).toBe(false);
  });
});

describe('Host allowlist (DNS rebinding)', () => {
  it.each([
    ['192.168.1.5:8096', true],
    ['[::1]:8096', true],
    ['localhost:8096', true],
    ['homecast.local:8096', true],
    ['HOMECAST.LOCAL', true],
    ['evil.example.com:8096', false],
    ['192.168.1.5.nip.io:8096', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (h, want) => expect(isAllowedHost(h as string | undefined)).toBe(want));

  it('extra names', () => expect(isAllowedHost('media-pc:8096', ['media-pc'])).toBe(true));
  it('hostOf', () => {
    expect(hostOf('[fe80::1]:80')).toBe('fe80::1');
    expect(hostOf('a.b:1')).toBe('a.b');
  });
});

describe('same-origin writes', () => {
  it('absent origin is allowed (SameSite cookie still applies)', () => expect(isSameOrigin(undefined, 'x:1')).toBe(true));
  it('matching origin', () => expect(isSameOrigin('http://192.168.1.5:8096', '192.168.1.5:8096')).toBe(true));
  it('foreign origin', () => expect(isSameOrigin('http://evil.com', '192.168.1.5:8096')).toBe(false));
  it('garbage origin', () => expect(isSameOrigin('null', '192.168.1.5:8096')).toBe(false));
});

describe('adapter selection', () => {
  const nic = (address: string, internal = false): NetworkInterfaceInfo =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as NetworkInterfaceInfo;
  const ifaces = {
    'vEthernet (WSL)': [nic('172.20.0.1')],
    'Ethernet 2': [nic('10.0.0.7')],
    'Wi-Fi': [nic('192.168.1.50')],
    'Docker NAT': [nic('192.168.65.1')],
    Loopback: [nic('127.0.0.1', true)],
    'APIPA': [nic('169.254.3.3')],
  };
  it('drops virtual adapters and prefers 192.168', () => {
    expect(lanAdapters(undefined, ifaces).map((a) => a.name)).toEqual(['Wi-Fi', 'Ethernet 2']);
  });
  it('honours the override', () => {
    expect(lanAdapters('vEthernet (WSL)', ifaces).map((a) => a.address)).toEqual(['172.20.0.1']);
  });
});
