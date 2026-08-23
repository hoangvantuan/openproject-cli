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
