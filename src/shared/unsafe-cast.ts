export function unsafeCast<T, V = unknown>(value: V): T {
  // SAFETY: intersecting T with V makes the assertion overlap; the caller named T.
  return value as T & V;
}
