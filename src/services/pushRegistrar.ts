/**
 * Aurix push-token registration -- pure logic, no React Native imports, so it
 * can be tested in plain Node with fakes.
 *
 * WHY THIS EXISTS (incident, Oct 2026)
 * The previous version did:
 *     addPushTokenListener(() => register(true))   // register -> getExpoPushTokenAsync
 * On Android, expo-notifications' getDevicePushTokenAsync() emits the
 * "onDevicePushToken" event after EVERY call (even when the token did not
 * change), and getExpoPushTokenAsync() calls it. So the listener re-triggered
 * itself forever, and force=true skipped the 24h cache: one POST to
 * register-device (plus one to exp.host) per loop turn, per device.
 *
 * Defences here are layered so that no single bug can recreate the loop:
 *  1. Kill switch (config flag). Off => nothing is touched at all.
 *  2. The token listener never fetches a token. It only compares the event's
 *     native token with the last one seen, and acts only on a real change.
 *  3. A real change is registered WITHOUT calling getDevicePushTokenAsync
 *     (we hand the new native token to getExpoPushTokenAsync), so our own work
 *     cannot emit another event.
 *  4. Single-flight: concurrent calls share one run.
 *  5. Persisted freshness: after a successful registration nothing touches the
 *     network for 24h (not even exp.host), across app restarts.
 *  6. Persisted budgets: at most MAX_POSTS_PER_DAY server posts per rolling
 *     24h, and at most MAX_RUNS_PER_PROCESS attempts per app process.
 *  7. Failures back off exponentially with jitter, persisted across restarts;
 *     Retry-After is honoured; permanent errors (410/4xx) stop for 24h.
 */

export const REFRESH_MS = 24 * 60 * 60 * 1000;
export const MAX_POSTS_PER_DAY = 6;
export const MAX_RUNS_PER_PROCESS = 5;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
export const PERMANENT_STOP_MS = 24 * 60 * 60 * 1000;
export const CHANGE_DEBOUNCE_MS = 5_000;
export const STORE_KEY = 'aurix:push:v2';

type PushTokenLike = { type?: string; data?: string };

export interface PushDeps {
  /** Master switch. false => init() does nothing at all. */
  enabled: boolean;
  platform: string;
  functionsUrl?: string;
  projectId?: string;
  appVersion?: string | null;
  notifications: {
    addPushTokenListener(l: (t: PushTokenLike) => void): { remove(): void };
    getPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
    requestPermissionsAsync(): Promise<{ granted: boolean }>;
    getDevicePushTokenAsync(): Promise<PushTokenLike>;
    getExpoPushTokenAsync(o?: {
      projectId?: string;
      devicePushToken?: PushTokenLike;
    }): Promise<{ data?: string | null }>;
  };
  storage: {
    getItem(k: string): Promise<string | null>;
    setItem(k: string, v: string): Promise<void>;
  };
  fetch: (url: string, init: any) => Promise<{ ok: boolean; status: number; headers?: { get(n: string): string | null } }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log?: (...a: unknown[]) => void;
}

type State = {
  /** Expo token last accepted by the server. */
  token?: string;
  /** When it was accepted. */
  at?: number;
  /** Timestamps of server POSTs in the last 24h. */
  posts: number[];
  failures: number;
  /** No attempt before this time (backoff / Retry-After / permanent stop). */
  notBefore?: number;
};

export type RunReason = 'startup' | 'token-changed';

export function createPushRegistrar(deps: PushDeps) {
  const log = deps.log ?? (() => undefined);
  let started = false;
  let inFlight: Promise<void> | null = null;
  let runsThisProcess = 0;
  let stoppedForProcess = false;
  /** Last native (FCM) token we have seen, from our own fetch or from events. */
  let lastNativeToken: string | null = null;
  let changeTimer: { cancel(): void } | null = null;
  let pendingChange: PushTokenLike | null = null;

  async function load(): Promise<State> {
    try {
      const raw = await deps.storage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as State;
        if (s && Array.isArray(s.posts)) return s;
      }
    } catch {
      /* corrupt/unavailable storage: start clean, budgets still apply per process */
    }
    return { posts: [], failures: 0 };
  }

  async function save(s: State): Promise<void> {
    try {
      await deps.storage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* best effort */
    }
  }

  const jitter = () => 0.5 + deps.random(); // 0.5x .. 1.5x
  const backoffMs = (failures: number) =>
    Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1)) * jitter();

  async function hasPermission(): Promise<boolean> {
    let perm = await deps.notifications.getPermissionsAsync();
    if (perm.granted) return true;
    if (perm.canAskAgain === false) return false;
    // The player asks for the Android 13+ permission at startup; wait so two
    // system dialogs don't race, then re-check before asking ourselves.
    await deps.sleep(4000);
    perm = await deps.notifications.getPermissionsAsync();
    if (perm.granted) return true;
    if (perm.canAskAgain === false) return false;
    perm = await deps.notifications.requestPermissionsAsync();
    return !!perm.granted;
  }

  async function post(token: string): Promise<{ ok: boolean; status: number; retryAfterMs?: number }> {
    if (!deps.functionsUrl) return { ok: false, status: 0 };
    try {
      const res = await deps.fetch(`${deps.functionsUrl}/register-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expo_push_token: token,
          platform: deps.platform,
          app_version: deps.appVersion ?? null,
        }),
      });
      let retryAfterMs: number | undefined;
      const ra = res.headers?.get('retry-after');
      if (ra && Number.isFinite(Number(ra))) retryAfterMs = Math.max(0, Number(ra)) * 1000;
      return { ok: res.ok, status: res.status, retryAfterMs };
    } catch {
      return { ok: false, status: 0 }; // network error
    }
  }

  async function runOnce(reason: RunReason, changed?: PushTokenLike): Promise<void> {
    if (stoppedForProcess) return;
    if (runsThisProcess >= MAX_RUNS_PER_PROCESS) {
      log('[push] per-process run cap reached');
      return;
    }
    runsThisProcess += 1;

    const now = deps.now();
    const state = await load();
    state.posts = state.posts.filter((t) => now - t < REFRESH_MS);

    // Backoff / permanent-stop window (persisted across restarts).
    if (state.notBefore && now < state.notBefore) return;
    // Fresh and nothing changed: no network at all (no native fetch, no exp.host).
    if (reason === 'startup' && state.token && state.at && now - state.at < REFRESH_MS) return;
    // Budget: never more than MAX_POSTS_PER_DAY server posts per rolling 24h.
    if (state.posts.length >= MAX_POSTS_PER_DAY) {
      log('[push] daily post budget reached');
      return;
    }

    // Get the Expo token. For a real native-token change we pass the new native
    // token in, so getDevicePushTokenAsync is NOT called (no event, no loop).
    let expoToken: string | null = null;
    try {
      const opts: { projectId?: string; devicePushToken?: PushTokenLike } = {};
      if (deps.projectId) opts.projectId = deps.projectId;
      if (changed?.data) opts.devicePushToken = changed;
      else {
        // Startup: record the native token BEFORE the SDK emits its event, so
        // that event is recognised as "same token" and ignored.
        const native = await deps.notifications.getDevicePushTokenAsync();
        if (native?.data) lastNativeToken = native.data;
        opts.devicePushToken = native;
      }
      const res = await deps.notifications.getExpoPushTokenAsync(opts);
      expoToken = res?.data ?? null;
    } catch (e) {
      log('[push] token fetch failed', e);
    }
    if (!expoToken) {
      state.failures += 1;
      state.notBefore = now + backoffMs(state.failures);
      await save(state);
      return;
    }

    if (state.token === expoToken && state.at && now - state.at < REFRESH_MS) {
      // Same Expo token (e.g. native token rotated but Expo token is stable):
      // nothing to tell the server.
      return;
    }

    state.posts.push(now);
    const r = await post(expoToken);
    if (r.ok) {
      state.token = expoToken;
      state.at = deps.now();
      state.failures = 0;
      state.notBefore = undefined;
    } else if (r.status === 410 || (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408)) {
      // Endpoint disabled / rejects us: do not retry, in this process or for 24h.
      stoppedForProcess = true;
      state.notBefore = deps.now() + PERMANENT_STOP_MS;
    } else {
      // 5xx, 429, 408, network error: exponential backoff with jitter.
      state.failures += 1;
      const wait = Math.max(backoffMs(state.failures), r.retryAfterMs ?? 0);
      state.notBefore = deps.now() + wait;
    }
    await save(state);
  }

  /** Single-flight wrapper: concurrent callers share one run. */
  function run(reason: RunReason, changed?: PushTokenLike): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = runOnce(reason, changed)
      .catch((e) => log('[push] run failed', e))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function onTokenEvent(t: PushTokenLike): void {
    const native = t?.data;
    if (typeof native !== 'string' || !native) return;
    if (lastNativeToken === null) {
      // First sighting (our own startup fetch, or the SDK's initial emit):
      // remember it, do not act.
      lastNativeToken = native;
      return;
    }
    if (native === lastNativeToken) return; // the SDK re-emits the same token constantly
    // Genuine rotation. Debounce a burst into one registration.
    lastNativeToken = native;
    pendingChange = t;
    changeTimer?.cancel();
    let cancelled = false;
    changeTimer = { cancel: () => { cancelled = true; } };
    void deps.sleep(CHANGE_DEBOUNCE_MS).then(() => {
      if (cancelled || !pendingChange) return;
      const c = pendingChange;
      pendingChange = null;
      void run('token-changed', c);
    });
  }

  async function init(): Promise<void> {
    if (started) return;
    started = true;
    if (!deps.enabled) return; // kill switch: touch nothing
    if (deps.platform === 'web') return;
    try {
      deps.notifications.addPushTokenListener(onTokenEvent);
      if (await hasPermission()) await run('startup');
    } catch (e) {
      log('[push] init failed', e);
    }
  }

  return { init, run, onTokenEvent, _debug: () => ({ runsThisProcess, stoppedForProcess, lastNativeToken }) };
}
