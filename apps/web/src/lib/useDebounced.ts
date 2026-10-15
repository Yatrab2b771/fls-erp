import { useEffect, useState } from "react";

/** The value, but only after it has stopped changing for `ms` - so typing in a filter box doesn't fire a request per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
