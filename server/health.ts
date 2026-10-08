// The health report: the same data the admin page's Health section shows.
import { openStreamCount } from './stream.ts';
import type { HlsJobs } from './hls.ts';
import type { Bins } from './bins.ts';
import type { Adapter } from './net.ts';
import type { Scanner } from './providers/fs/scan.ts';
import { countItems } from './providers/fs/repo.ts';
import type { Database } from './store.ts';
import { firewallState, networkProfiles, type FirewallState, type NetworkProfile } from './system.ts';

export const VERSION = '0.2.0';

export interface HealthDeps {
  db: Database;
  bins: Bins;
  hls: HlsJobs | null;
  scanner: Scanner;
  encoder: () => string;
  encoders?: () => readonly string[];
  adapters: () => Adapter[];
  port: () => number;
  startedAt: number;
}

// PowerShell checks are slow (~1s): cache them.
let osCache: { at: number; profiles: NetworkProfile[]; firewall: FirewallState | null } | null = null;
async function osChecks(): Promise<{ profiles: NetworkProfile[]; firewall: FirewallState | null }> {
  if (osCache && Date.now() - osCache.at < 60_000) return osCache;
  const [profiles, firewall] = await Promise.all([networkProfiles(), firewallState()]);
  osCache = { at: Date.now(), profiles, firewall };
  return osCache;
}

export function healthReport(d: HealthDeps): (full: boolean) => Promise<unknown> {
  return async (full) => {
    const base = { ok: true, name: 'HomeCast', version: VERSION };
    if (!full) return base;
    const adapters = d.adapters();
    const { profiles, firewall } = await osChecks();
    const adapter = adapters[0] ?? null;
    const profile = adapter ? profiles.find((p) => p.alias === adapter.name) : undefined;
    const warnings: string[] = [];
    if (!d.bins.ffmpeg) warnings.push('ffmpeg was not found: only files the TV plays natively will work, and there are no thumbnails.');
    if (!d.bins.ffprobe) warnings.push('ffprobe was not found: files cannot be analysed.');
    if (d.bins.ffmpeg && !(d.encoders?.() ?? []).some((e) => e !== 'libx264')) {
      warnings.push((d.encoders?.() ?? []).includes('libx264')
        ? 'No verified hardware encoder was found: conversion will use the CPU.'
        : 'No compatible encoder was verified: some files cannot be converted.');
    }
    if (!adapter) warnings.push('No home network adapter found. Connect to Wi-Fi or Ethernet, or set "adapter" in config.json.');
    if (profile?.category === 'Public') warnings.push(`Windows treats "${profile.alias}" as a Public network. Set it to Private in Settings > Network & internet, or TVs cannot connect.`);
    if (firewall?.allowedPublic) warnings.push('The firewall allows HomeCast on Public networks too. Untick "Public" in Windows Defender Firewall > Allowed apps.');
    if (firewall?.blocked) warnings.push('The firewall blocks HomeCast on Private networks. Allow it in Windows Defender Firewall > Allowed apps.');
    const scan = d.scanner.status();
    for (const r of scan.offlineRoots) warnings.push(`Folder is offline: ${r}`);
    return {
      ...base,
      uptimeSec: Math.round((Date.now() - d.startedAt) / 1000),
      ffmpeg: d.bins.ffmpeg !== null,
      ffprobe: d.bins.ffprobe !== null,
      encoder: d.encoder(),
      encoders: d.encoders?.() ?? [d.encoder()],
      activeJobs: d.hls?.activeJobs() ?? 0,
      cacheBytes: (await d.hls?.cacheBytes()) ?? 0,
      openStreams: openStreamCount(),
      adapter,
      urls: adapters.map((a) => `http://${a.address}:${d.port()}/`),
      networkProfile: profile?.category ?? null,
      firewall,
      library: { ...countItems(d.db), scanning: scan.scanning, lastScanAt: scan.lastScanAt },
      warnings,
    };
  };
}
