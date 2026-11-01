/**
 * Explore's "Recent searches" list.
 *
 * A search can be saved while the user is still typing (the debounced search
 * finished), so "a", "ag", "ago", "agora" would each become an entry. Saving a
 * new term therefore drops earlier entries that are only a shorter start of it.
 */
export function mergeRecent(prev: readonly string[], term: string, max: number): string[] {
  const t = term.trim().replace(/\s+/g, ' ');
  if (t.length < 2) return prev.slice(0, max);

  const lower = t.toLowerCase();
  const rest = prev.filter((entry) => {
    const e = entry.trim().toLowerCase();
    // The same search, or an earlier, shorter state of the same typing.
    return e !== lower && !lower.startsWith(e);
  });
  return [t, ...rest].slice(0, max);
}
