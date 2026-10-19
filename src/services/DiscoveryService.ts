import AsyncStorage from '@react-native-async-storage/async-storage';
import { Track } from '../core/types';
import { readJson, writeJson } from '../core/storage';
import { MusicService } from './MusicService';

/**
 * Data behind Explore's "Recent searches", "Trending" and "Top songs".
 *
 * It exists so the Search tab never opens empty: the lists are fetched at app
 * start, the last good copy is kept on disk, and the screen reads a ready
 * snapshot synchronously. A refresh only ever replaces data with newer
 * non-empty data, so a failed fetch can never blank the page.
 */

const RECENT_KEY = 'note_recent_searches'; // same key Search always used
const SNAPSHOT_KEY = 'discovery-v1';
const MAX_RECENT = 4;
const STALE_MS = 10 * 60 * 1000;

export const TRENDING_QUERY = 'trending songs this week';
/** The year is computed, so this chart can never silently go stale again. */
export const chartQuery = (now = new Date()): string => `top global hits ${now.getFullYear()}`;

export type DiscoverySnapshot = {
  trending: Track[];
  chart: Track[];
  recent: string[];
  /** 'loading' until the first load finished; 'failed' only if nothing could be shown. */
  status: 'loading' | 'ready' | 'failed';
};

type Stored = { trending: Track[]; chart: Track[]; at: number; chartFor: string };
type Listener = (s: DiscoverySnapshot) => void;

let snapshot: DiscoverySnapshot = { trending: [], chart: [], recent: [], status: 'loading' };
let fetchedAt = 0;
let storedChartFor = '';
let started: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
const listeners = new Set<Listener>();

function publish(next: Partial<DiscoverySnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l(snapshot));
}

const usable = (t: unknown): t is Track =>
  !!t && typeof (t as Track).id === 'string' && typeof (t as Track).title === 'string' && !!(t as Track).artist;

async function loadStored(): Promise<void> {
  try {
    const [rawRecent, stored] = await Promise.all([
      AsyncStorage.getItem(RECENT_KEY).catch(() => null),
      readJson<Stored | null>(SNAPSHOT_KEY, null),
    ]);
    let recent: string[] = [];
    try {
      const parsed = rawRecent ? JSON.parse(rawRecent) : [];
      if (Array.isArray(parsed)) {
        recent = parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT);
      }
    } catch {
      /* corrupt recents: start empty */
    }
    const trending = Array.isArray(stored?.trending) ? stored!.trending.filter(usable) : [];
    const chart = Array.isArray(stored?.chart) ? stored!.chart.filter(usable) : [];
    fetchedAt = typeof stored?.at === 'number' ? stored.at : 0;
    storedChartFor = typeof stored?.chartFor === 'string' ? stored.chartFor : '';
    publish({
      recent,
      trending,
      chart,
      status: trending.length || chart.length ? 'ready' : snapshot.status,
    });
  } catch {
    /* nothing stored: the network load below fills it */
  }
}

async function fetchFresh(): Promise<void> {
  const q = chartQuery();
  const [t, c] = await Promise.all([
    MusicService.search(TRENDING_QUERY, { limit: 8 }).then((r) => r.tracks).catch(() => [] as Track[]),
    MusicService.search(q, { limit: 10 }).then((r) => r.tracks).catch(() => [] as Track[]),
  ]);
  // Never replace good data with nothing: a failed fetch keeps what is shown.
  const trending = t.length ? t : snapshot.trending;
  const chart = c.length ? c : snapshot.chart;
  if (t.length || c.length) {
    fetchedAt = Date.now();
    if (c.length) storedChartFor = q;
    void writeJson(SNAPSHOT_KEY, { trending, chart, at: fetchedAt, chartFor: storedChartFor } satisfies Stored);
  }
  publish({
    trending,
    chart,
    status: trending.length || chart.length ? 'ready' : 'failed',
  });
}

export const DiscoveryService = {
  get(): DiscoverySnapshot {
    return snapshot;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /**
   * Load the stored copy, then refresh from the network when it is missing or
   * old. Safe to call any number of times; concurrent calls share one run.
   */
  warm(): Promise<void> {
    if (!started) {
      started = (async () => {
        await loadStored();
        await DiscoveryService.refresh(false);
      })().catch(() => {
        started = null;
      });
    } else {
      void started.then(() => DiscoveryService.refresh(false));
    }
    return started ?? Promise.resolve();
  },

  /** Fetch new lists. Without `force`, does nothing while the data is fresh. */
  refresh(force: boolean): Promise<void> {
    const fresh =
      Date.now() - fetchedAt < STALE_MS &&
      snapshot.trending.length > 0 &&
      snapshot.chart.length > 0 &&
      storedChartFor === chartQuery();
    if (!force && fresh) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = fetchFresh()
      .catch(() => publish({ status: snapshot.trending.length || snapshot.chart.length ? 'ready' : 'failed' }))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  },

  saveRecent(list: string[]): void {
    const clean = list.slice(0, MAX_RECENT);
    publish({ recent: clean });
    AsyncStorage.setItem(RECENT_KEY, JSON.stringify(clean)).catch(() => undefined);
  },
};
