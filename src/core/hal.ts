// HAL resources arrive untyped from the HTTP layer; each entry point
// validates only what it consumes, mirroring the HalElement convention of
// context/metadata.ts.
interface HalResource {
  readonly [key: string]: unknown;
}

/**
 * A HAL link reduced to the two facts a caller needs: which resource it
 * points at and what humans call it. Unknown or unparseable hrefs yield
 * null rather than a fabricated id.
 */
export interface FlatLink {
  readonly id: number | null;
  readonly name: string | null;
}

/** Trailing numeric segment of an href ("/api/v3/types/2" -> 2). */
export function halRefId(href: string | undefined | null): number | null {
  if (href === undefined || href === null) {
    return null;
  }
  const match = /(\d+)\/?$/.exec(href);
  return match === null ? null : Number(match[1]);
}

export function flattenHalLink(link: unknown): FlatLink {
  const body = link as HalLinkBody | null | undefined;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { id: null, name: null };
  }
  return {
    id: halRefId(typeof body.href === "string" ? body.href : null),
    name: typeof body.title === "string" ? body.title : null,
  };
}

interface HalLinkBody {
  readonly href?: unknown;
  readonly title?: unknown;
}

function isFlatLink(value: unknown): value is FlatLink {
  const record = value as Record<string, unknown> | null | undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return false;
  }
  return (
    Object.keys(record).every((key) => key === "id" || key === "name")
    && ("id" in record || "name" in record)
  );
}

/**
 * Flatten one HAL resource in place: `_type` is dropped, every `_links`
 * entry except `self` shrinks to `{ id, name }`, embedded resources are
 * flattened recursively, and scalars pass through untouched. The result
 * is the bare record; nothing wraps it.
 */
export function flattenHalRecord(
  record: unknown,
): Record<string, unknown> {
  const resource = record as HalResource | null | undefined;
  if (typeof resource !== "object" || resource === null || Array.isArray(resource)) {
    throw new TypeError("expected a HAL resource object");
  }
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource)) {
    if (key === "_type" || key === "_embedded" || key === "_links") {
      continue;
    }
    flat[key] = Array.isArray(value)
      ? value.map(flattenHalRecord)
      : typeof value === "object" && value !== null
        ? flattenHalRecord(value)
        : value;
  }
  const links = resource._links as HalResource | undefined;
  if (typeof links === "object" && links !== null) {
    for (const [key, link] of Object.entries(links)) {
      if (key === "self") {
        continue;
      }
      flat[key] = Array.isArray(link)
        ? link.map(flattenHalLink)
        : flattenHalLink(link);
    }
  }
  return flat;
}

export { isFlatLink };
