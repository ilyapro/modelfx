export function safe<A extends any[], R>(
  fn: ((...args: A) => R | void) | void,
): (...args: A) => R | void {
  return fn
    ? (...args) => {
        try {
          return fn(...args);
        } catch (error) {
          console.log(error);
        }
      }
    : () => {};
}
