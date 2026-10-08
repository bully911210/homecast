// Windows integration using only built-in tools: reg.exe, PowerShell, explorer. No admin rights needed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { log } from './log.ts';
import { run } from './run.ts';

const WIN = process.platform === 'win32';
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const VALUE = 'HomeCast';

/** The command that starts this server again (the exe itself, or node + entry script in dev). */
export function selfCommand(): { exe: string; args: string[] } {
  if (isSea()) return { exe: process.execPath, args: [] };
  return { exe: process.execPath, args: [resolve(process.argv[1] ?? 'server/main.ts')] };
}

function quoted(): string {
  const { exe, args } = selfCommand();
  return [exe, ...args].map((p) => `"${p}"`).join(' ') + ' --background';
}

export async function autostartEnabled(): Promise<boolean> {
  if (!WIN) return false;
  const r = await run('reg', ['query', RUN_KEY, '/v', VALUE], 5000).catch(() => null);
  return r?.code === 0;
}

/**
 * Start at logon via the per-user Run key. (Task Scheduler logon triggers need admin rights,
 * which this app never asks for.)
 */
export async function setAutostart(on: boolean): Promise<void> {
  if (!WIN) throw new Error('start at logon is only supported on Windows');
  const args = on ? ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', quoted(), '/f'] : ['delete', RUN_KEY, '/v', VALUE, '/f'];
  const r = await run('reg', args, 5000);
  if (r.code !== 0 && on) throw new Error(`could not update the Run key: ${r.stderr.trim()}`);
}

/** Values reach PowerShell through the environment, never spliced into the script text. */
async function powershellJson(script: string, env: Record<string, string> = {}): Promise<unknown> {
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000, env);
  const text = r.stdout.toString('utf8').trim();
  return text ? JSON.parse(text) : null;
}

export interface NetworkProfile {
  alias: string;
  category: 'Public' | 'Private' | 'DomainAuthenticated' | 'Unknown';
}

const CATEGORY = ['Public', 'Private', 'DomainAuthenticated'] as const;

export async function networkProfiles(): Promise<NetworkProfile[]> {
  if (!WIN) return [];
  try {
    const raw = await powershellJson('Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress');
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { InterfaceAlias: string; NetworkCategory: number | string }[];
    return list.map((p) => ({
      alias: p.InterfaceAlias,
      category: typeof p.NetworkCategory === 'number' ? (CATEGORY[p.NetworkCategory] ?? 'Unknown') : (p.NetworkCategory as NetworkProfile['category']),
    }));
  } catch {
    return [];
  }
}

export interface FirewallState {
  allowedPrivate: boolean;
  allowedPublic: boolean;
  blocked: boolean;
  rules: number;
}

/** Inspect inbound firewall rules for this program (Windows creates them from its first-run prompt). */
export async function firewallState(): Promise<FirewallState | null> {
  if (!WIN) return null;
  const script =
    `$r = Get-NetFirewallApplicationFilter -Program $env:HOMECAST_PROGRAM -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } | Select-Object @{n='p';e={[string]$_.Profile}},@{n='a';e={[string]$_.Action}}; ` +
    `if ($r) { $r | ConvertTo-Json -Compress } else { '[]' }`;
  try {
    const raw = await powershellJson(script, { HOMECAST_PROGRAM: process.execPath });
    const rules = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { p: string; a: string }[];
    const has = (profile: string, action: string): boolean => rules.some((r) => r.a === action && (r.p === 'Any' || r.p.includes(profile)));
    return { allowedPrivate: has('Private', 'Allow'), allowedPublic: has('Public', 'Allow'), blocked: has('Private', 'Block'), rules: rules.length };
  } catch {
    return null;
  }
}

export function openBrowser(url: string): void {
  const [cmd, args] = WIN ? ['explorer', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    log.warn('could not open the browser', err instanceof Error ? err.message : err);
  }
}

/** Launch the tray status light as a detached process so it can show red when we die. */
export function startTray(port: number): void {
  if (!WIN || process.env.HOMECAST_NO_TRAY === '1') return;
  const candidates = [join(dirname(process.execPath), 'tray.ps1'), join(process.cwd(), 'tools', 'tray.ps1')];
  const script = candidates.find((p) => existsSync(p));
  if (!script) return;
  const { exe, args } = selfCommand();
  // Windows PowerShell 5.1 exits at once when started without a console (detached), and a
  // non-detached child dies with us (libuv job object). `start` gives it its own console.
  // Paths travel in environment variables: cmd expands %VAR% once and never re-parses the value,
  // so quotes, %, & and trailing backslashes in install paths can't break the command line.
  const env = {
    ...process.env,
    HOMECAST_TRAY_SCRIPT: script,
    HOMECAST_TRAY_START: [exe, ...args].join('|'),
    HOMECAST_TRAY_CWD: process.cwd(),
  };
  const line =
    `start "HomeCast tray" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass ` +
    `-File "%HOMECAST_TRAY_SCRIPT%" -Port ${Math.floor(port)}`;
  try {
    spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } catch (err) {
    log.warn('could not start the tray icon', err instanceof Error ? err.message : err);
  }
}
