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
  readonly method?: unknown;
}

/**
 * Whether a link belongs in the flat record. HAL mixes two kinds under
 * `_links`: attributes that point at a resource, and operations the
 * caller may perform. An operation declares its `method`, and its href
 * often ends in the record's own id, so keeping it would spell an
 * unrelated action as if it were a resource. A link that names nothing
 * at all (`{"id":null,"name":null}` from a real href, such as a
 * sub-collection endpoint) carries no fact either. What stays is every
 * link that names a resource, plus the unset attributes whose href is
 * null: "no version" is data.
 */
function namesAResource(link: unknown, flat: FlatLink): boolean {
  const body = link as HalLinkBody | null | undefined;
  if (typeof body === "object" && body !== null && body.method !== undefined) {
    return false;
  }
  if (flat.id !== null || flat.name !== null) {
    return true;
  }
  return typeof body?.href !== "string";
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
 * Flatten one HAL resource in place: `_type` is dropped, `_embedded` is
 * stripped (embedded resources are never merged into the record), every
 * `_links` entry except `self` and the operations shrinks to
 * `{ id, name }`, and scalars pass through untouched. The result is the
 * bare record; nothing wraps it. See ADR-0003 for what the shape
 * promises.
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
      if (Array.isArray(link)) {
        flat[key] = link.map(flattenHalLink);
        continue;
      }
      const flatLink = flattenHalLink(link);
      if (namesAResource(link, flatLink)) {
        flat[key] = flatLink;
      }
    }
  }
  return flat;
}

/**
 * The write form of a Formattable field. API v3 models `description` and
 * `comment` as `{ raw, format }`: a bare string is accepted, silently
 * ignored, and reported as success, so every write goes through here.
 */
export function toFormattable(value: string): { readonly raw: string } {
  return { raw: value };
}

/**
 * The markdown behind a Formattable field as it arrives: the `raw` of the
 * object the API returns, the string itself when an instance answers with
 * one, null when the field carries nothing.
 */
export function formattableRaw(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>).raw;
  return typeof raw === "string" ? raw : null;
}

export { isFlatLink };
