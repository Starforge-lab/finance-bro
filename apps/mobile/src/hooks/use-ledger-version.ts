import { addDatabaseChangeListener } from 'expo-sqlite';
import { useSyncExternalStore } from 'react';

let version = 0;
let pending: ReturnType<typeof setTimeout> | undefined;
let subscribed = false;
const listeners = new Set<() => void>();

function start() {
  if (subscribed) return;
  subscribed = true;
  // One save writes several rows; coalesce them into a single refresh.
  addDatabaseChangeListener(() => {
    pending ??= setTimeout(() => {
      pending = undefined;
      version += 1;
      listeners.forEach((listener) => listener());
    }, 50);
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Changes whenever the ledger is written, so screens refresh on data changes instead of on every tab focus. */
export function useLedgerVersion() {
  return useSyncExternalStore(subscribe, () => version);
}
