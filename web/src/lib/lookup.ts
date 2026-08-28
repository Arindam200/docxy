/**
 * Read an entry from a literal map with a key only known at runtime.
 *
 * The maps this serves are declared with `satisfies` rather than an annotation,
 * so they keep their literal key types instead of widening to an open
 * dictionary — the keys really are known, and the type now says so. What that
 * costs is indexing with a plain string, which TypeScript rightly refuses.
 *
 * Handling the miss here means it is handled once, and honestly: the result is
 * `undefined` when the key is absent, which is what every caller was already
 * writing `?? fallback` against.
 */
export function lookup<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
