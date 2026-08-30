import { z } from "zod";

import type { JsonObject, JsonValue } from "./json";

const stringSchema = z.string();
const jsonNumberSchema = z.number();
const booleanSchema = z.boolean();
const jsonSchema = z.json();

type Inspectable =
  | JsonValue
  | number
  | boolean
  | string
  | bigint
  | symbol
  | null
  | undefined
  | AnyFn;

export type AnyFn = (
  ...args: never[]
) => JsonValue | number | boolean | string | null | undefined | void;

// The generic call signature accepts any caller value; the implementation only
// inspects Inspectable runtime cases. TypeScript forbids `value is R` on a
// unconstrained T, so the alias is a lie at the type level and honest at runtime.
// @ts-expect-error TS2677
type Guard<R> = <T>(value: T) => value is R;

function asGuard<R>(guard: (value: Inspectable) => boolean): Guard<R> {
  // SAFETY: Zod (or instanceof) already classified the runtime value; the
  // generic signature only exists so callers can pass untyped I/O without an
  // unknown annotation on this module.
  return guard as Guard<R>;
}

/** Narrow an untyped value to a plain object record. Arrays and null are rejected so callers can safely index string keys. Owned here so every layer imports one implementation instead of a local copy. */
// Structural on purpose: an Error carrying a refusal code, or any other class instance with string keys, is a record to its callers. A record parse would reject those and every caller that indexes `.code` would silently see "not a record"; the loose object parse admits any non-array object.
const recordSchema = z.looseObject({});

export const isRecord: Guard<JsonObject> = asGuard(
  (value) => recordSchema.safeParse(value).success,
);

export const isString: Guard<string> = asGuard(
  (value) => stringSchema.safeParse(value).success,
);

export const isNumber: Guard<number> = asGuard(
  (value) =>
    jsonNumberSchema.safeParse(value).success ||
    value !== value ||
    value === Infinity ||
    value === -Infinity,
);

export const isBoolean: Guard<boolean> = asGuard(
  (value) => booleanSchema.safeParse(value).success,
);

export const isFiniteNumber: Guard<number> = asGuard(
  (value) => jsonNumberSchema.safeParse(value).success,
);

export const isFunction: Guard<AnyFn> = asGuard(
  (value) => value instanceof Function,
);

export const isJsonValue: Guard<JsonValue> = asGuard(
  (value) => jsonSchema.safeParse(value).success,
);
