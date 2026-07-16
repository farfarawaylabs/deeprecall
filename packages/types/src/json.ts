import { z } from 'zod';

/**
 * A value representable in JSON. Used for fields that round-trip through
 * JSON.parse/JSON.stringify (e.g. D1 TEXT columns holding JSON) so their
 * TypeScript type stays structured-clone serializable — `unknown` is not,
 * and poisons any type that crosses a Workers RPC service binding
 * (the whole record collapses to `never` on the caller side).
 */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;

// Interfaces (not type aliases) so TypeScript resolves the recursion
// lazily — an alias recurses eagerly inside the workers-types RPC
// serialization conditionals and hits TS2589 (instantiation too deep).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the empty extends IS the lazy indirection
export interface JsonArray extends Array<JsonValue> {}
export interface JsonObject {
  [key: string]: JsonValue;
}

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);
