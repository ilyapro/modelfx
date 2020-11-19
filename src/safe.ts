export function safe<A extends any[], R>(fn: (...args: A) => R): typeof fn {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error(error);
    }
    return undefined as any;
  };
}
