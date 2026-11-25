import React from "react";

/**
 * Returns `value` once it has stopped changing for `delayMs`. Pass a value
 * with a stable identity (a primitive or a memoized object): every new
 * identity restarts the wait.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
