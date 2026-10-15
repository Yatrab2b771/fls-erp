import { useSyncExternalStore } from "react";

// How many rows a list shows per page. 10 to start; each person can pick another size under any list, and it is remembered in this browser
// and used by every list.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

const KEY = "fls.pageSize";
const listeners = new Set<() => void>();

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

let current = read();

export function setPageSizePref(size: number): void {
  if (!(PAGE_SIZE_OPTIONS as readonly number[]).includes(size) || size === current) return;
  current = size;
  try {
    localStorage.setItem(KEY, String(size));
  } catch {
    // not remembered, but still used for this visit
  }
  listeners.forEach((l) => l());
}

export function usePageSize(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
