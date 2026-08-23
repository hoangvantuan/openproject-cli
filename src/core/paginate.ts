import { OpCliError } from "./errors.js";

export const DEFAULT_PAGE_SIZE = 100;

/** Same contract as the flag of `wp list`: a whole number of 1 or more. */
export function parsePageSize(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new OpCliError(
      "USAGE_ERROR",
      `--limit "${raw}" is not a positive integer.`,
      "pass a whole number of 1 or more.",
    );
  }
  return Number(raw);
}

/** Append pageSize to an endpoint path that may or may not carry a query. */
export function withPageSize(path: string, size: number): string {
  return `${path}${path.includes("?") ? "&" : "?"}pageSize=${String(size)}`;
}

export interface HalLink {
  readonly href?: string;
}

export interface HalCollection {
  readonly _embedded?: {
    readonly elements?: readonly unknown[];
  };
  readonly _links?: {
    readonly nextByOffset?: HalLink;
  };
}

/**
 * Reduce a nextByOffset href (path or absolute URL) to the path the API
 * client should request next, or undefined when the collection ended.
 */
export function halNextPath(href: string | undefined): string | undefined {
  if (href === undefined || href === "") {
    return undefined;
  }
  const url = new URL(href, "https://op-cli.invalid");
  return `${url.pathname}${url.search}`;
}

/**
 * Walk a HAL collection page by page, yielding every element in server
 * order. The only pagination contract is `_links.nextByOffset`.
 */
export async function* halElements<T>(
  getPage: (path: string) => Promise<unknown>,
  startPath: string,
): AsyncGenerator<T> {
  let path: string | undefined = startPath;
  while (path !== undefined) {
    const collection = (await getPage(path)) as HalCollection;
    for (const element of collection._embedded?.elements ?? []) {
      yield element as T;
    }
    path = halNextPath(collection._links?.nextByOffset?.href);
  }
}
