/** A value an untyped caller can put in a stage: a name, a list of operands, or empty options. */
export type ForeignValue =
  | string
  | readonly (number | string)[]
  | Record<string, never>;

/**
 * `base` with its property `key` holding `value`, which the property's type refuses, as a
 * JavaScript caller can hand it over: the property is written at runtime, past the compiler.
 */
export function WithForeign<T extends object>(
  base: T,
  key: keyof T & string,
  value: ForeignValue,
): T {
  Object.defineProperty(base, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return base;
}
