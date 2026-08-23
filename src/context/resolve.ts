import { OpCliError } from "../core/errors.js";

/**
 * One metadata row a name can resolve to. `owner` names the vocabulary
 * that holds the entry ("type Task", "User", "version 0.1.0"), so an
 * ambiguous name can report every candidate with its owning type.
 */
export interface NamedEntry<V = number | string> {
  readonly name: string;
  readonly owner: string;
  readonly value: V;
}

export type NameMatch<V> =
  | { readonly kind: "unique"; readonly entry: NamedEntry<V> }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<NamedEntry<V>> }
  | { readonly kind: "missing" };

export function isIdForm(raw: string): boolean {
  return /^\d+$/.test(raw);
}

/**
 * The explicit `customFieldN` spelling of a field key. It is accepted
 * wherever a human field name is, to disambiguate a name defined by more
 * than one work package type.
 */
export function explicitCustomFieldKey(raw: string): string | undefined {
  const normalized = raw.toLowerCase();
  return /^customfield\d+$/.test(normalized)
    ? normalized.replace(/^customfield/, "customField")
    : undefined;
}

/**
 * Exact-name matching over one vocabulary snapshot. Entries carrying the
 * same value collapse together (the same user may sit in several
 * memberships); distinct values under one name are ambiguous.
 */
export function matchByName<V>(
  raw: string,
  entries: ReadonlyArray<NamedEntry<V>>,
): NameMatch<V> {
  const hits = entries.filter((entry) => entry.name === raw);
  if (hits.length === 0) {
    return { kind: "missing" };
  }
  const distinct = new Map<string, NamedEntry<V>>();
  for (const entry of hits) {
    const key = typeof entry.value === "string" ? entry.value : String(entry.value);
    if (!distinct.has(key)) {
      distinct.set(key, entry);
    }
  }
  const candidates = [...distinct.values()];
  return candidates.length === 1
    ? { kind: "unique", entry: candidates[0] as NamedEntry<V> }
    : { kind: "ambiguous", candidates };
}

function editDistance(a: string, b: string): number {
  let previous: Array<number> = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: Array<number> = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * Valid values ordered by closeness to what the caller typed (case
 * ignored), ties alphabetical, so a failed resolution teaches instead of
 * just failing.
 */
export function rankByCloseness(
  raw: string,
  names: ReadonlyArray<string>,
): Array<string> {
  const needle = raw.toLowerCase();
  return [...new Set(names)].sort((a, b) =>
    editDistance(needle, a.toLowerCase()) - editDistance(needle, b.toLowerCase())
    || a.localeCompare(b),
  );
}

export interface LookupSource<V> {
  /** Noun used in failure messages, e.g. `status`, `assignee`. */
  readonly label: string;
  /** Current vocabulary snapshot. */
  readonly load: () => Promise<ReadonlyArray<NamedEntry<V>>>;
  /** One automatic refresh; called at most once per lookup. */
  readonly refresh: () => Promise<void>;
}

function missingError(
  raw: string,
  source: LookupSource<unknown>,
  names: ReadonlyArray<string>,
): OpCliError {
  return new OpCliError(
    "USAGE_ERROR",
    `${source.label} "${raw}" not found. Valid values, closest first: `
      + `${rankByCloseness(raw, names).join(", ")}.`,
    "run op-cli meta refresh if the instance changed recently.",
  );
}

function ambiguityError(
  raw: string,
  source: LookupSource<unknown>,
  candidates: ReadonlyArray<NamedEntry<unknown>>,
): OpCliError {
  const listed = candidates
    .map((candidate) => `${String(candidate.value)} (${candidate.owner})`)
    .join(", ");
  return new OpCliError(
    "USAGE_ERROR",
    `${source.label} "${raw}" is ambiguous. Candidates: ${listed}.`,
    "repeat the value in the explicit id or key form of one candidate.",
  );
}

/**
 * Resolve a non-id value against metadata: exact match wins, a miss
 * triggers exactly one refresh and one retry, and every remaining failure
 * is a loud exit-1 misuse that never guesses on the caller's behalf.
 */
export async function resolveName<V>(
  raw: string,
  source: LookupSource<V>,
): Promise<V> {
  let match = matchByName(raw, await source.load());
  if (match.kind === "missing") {
    await source.refresh();
    match = matchByName(raw, await source.load());
  }
  if (match.kind === "unique") {
    return match.entry.value;
  }
  if (match.kind === "ambiguous") {
    throw ambiguityError(raw, source, match.candidates);
  }
  const all = await source.load();
  throw missingError(raw, source, all.map((entry) => entry.name));
}
