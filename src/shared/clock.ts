/** The `now()` seam most modules inject for testability, returning the current time as a `Date`. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** The `now()` seam for modules that want the current time as epoch milliseconds. */
export type NowFn = () => number;
export const systemNow: NowFn = Date.now;

/** The `now()` seam for modules that want the current time as an ISO 8601 string. */
export type NowIsoFn = () => string;
export const systemNowIso: NowIsoFn = () => new Date().toISOString();
