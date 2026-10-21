import Constants from 'expo-constants';
import { bestClockSample, clockSample } from './syncLogic';
import { SYNC } from './syncTypes';

/**
 * Talks to the dedicated Sync Play Supabase project over plain HTTPS:
 *  - the on/off switch (`app_flags`, read-only for the app)
 *  - the server clock (`server_now()`), so every device agrees on "now"
 *
 * This is a DIFFERENT project from the one used for push notifications.
 * Nothing here ever throws: failures come back as values, and a failure to
 * reach the switch means Sync Play is treated as unavailable. Normal playback
 * never depends on any of this.
 */

type Extra = { syncSupabaseUrl?: string; syncSupabaseKey?: string };
const extra = (): Extra => (Constants.expoConfig?.extra ?? {}) as Extra;

export type SyncConfig = { url: string; key: string };

export function syncConfig(): SyncConfig | null {
  const { syncSupabaseUrl: url, syncSupabaseKey: key } = extra();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function headers(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy anon keys are JWTs and may be sent as a bearer token; new-style
  // publishable keys must not be.
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export type FlagResult =
  | { ok: true; enabled: boolean; message: string }
  | { ok: false; message: string };

const UNREACHABLE = "Can't reach Sync Play right now. Check your connection and try again.";
const MAINTENANCE = 'Sync Play is under maintenance right now. Please try again later.';

/** Is Sync Play switched on? Any failure counts as "not available". */
export async function fetchSyncFlag(): Promise<FlagResult> {
  const r = await fetchAppFlag('sync_play');
  if (!r.ok) return { ok: false, message: r.message === 'unconfigured' ? 'Sync Play is not set up in this build.' : UNREACHABLE };
  const message = r.message || MAINTENANCE;
  return { ok: true, enabled: r.enabled, message: r.enabled ? '' : message };
}

/**
 * Read one row of `app_flags`. `ok: false` means the flag could not be read
 * (not configured / offline); the caller decides whether that means on or off.
 */
export async function fetchAppFlag(
  key: string
): Promise<{ ok: true; found: boolean; enabled: boolean; message: string } | { ok: false; message: string }> {
  const cfg = syncConfig();
  if (!cfg) return { ok: false, message: 'unconfigured' };
  try {
    const r = await fetchJson(
      `${cfg.url}/rest/v1/app_flags?select=enabled,message&key=eq.${encodeURIComponent(key)}`,
      { method: 'GET', headers: headers(cfg.key) },
      8000
    );
    if (!r.ok || !Array.isArray(r.body)) return { ok: false, message: 'unreachable' };
    const row = r.body[0] as { enabled?: unknown; message?: unknown } | undefined;
    const enabled = row?.enabled === true;
    const message = typeof row?.message === 'string' ? row.message.trim() : '';
    return { ok: true, found: !!row, enabled, message };
  } catch {
    return { ok: false, message: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Shared clock
// ---------------------------------------------------------------------------

let offsetMs = 0;
let clockReady = false;

/** Server time (ms since epoch), as best this device knows it. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function isClockReady(): boolean {
  return clockReady;
}

/**
 * Measure this device's clock against the server's: a few round trips, keeping
 * the one with the smallest delay (it is the least distorted by the network).
 * Typically accurate to ~50-100 ms. Returns false if no sample worked.
 */
export async function measureClock(): Promise<boolean> {
  const cfg = syncConfig();
  if (!cfg) return false;
  const samples: { offset: number; rtt: number }[] = [];
  for (let i = 0; i < SYNC.CLOCK_SAMPLES; i++) {
    try {
      const t0 = Date.now();
      const r = await fetchJson(
        `${cfg.url}/rest/v1/rpc/server_now`,
        { method: 'POST', headers: headers(cfg.key), body: '{}' },
        4000
      );
      const t1 = Date.now();
      const serverMs = typeof r.body === 'number' ? r.body : Number(r.body);
      if (r.ok && Number.isFinite(serverMs) && serverMs > 0) {
        samples.push(clockSample(t0, t1, serverMs));
      }
    } catch {
      /* skip this sample */
    }
  }
  const best = bestClockSample(samples);
  if (!best) return false;
  offsetMs = best.offset;
  clockReady = true;
  return true;
}
