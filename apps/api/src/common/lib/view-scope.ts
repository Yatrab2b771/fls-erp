import { AsyncLocalStorage } from "node:async_hooks";

// An ADMIN who is "viewing as" one Day Store or one Plant (the web app sends X-View-As-Scope: DAYSTORE:<id> | PLANT:<id>) is scoped
// like that store's / plant's own login for the length of the request. Nobody else can use it: the header is read only for ADMIN.
export interface ViewScope {
  dayStoreIds?: string[];
  plantIds?: string[];
}

export const viewScopeStore = new AsyncLocalStorage<ViewScope>();

export function adminViewScope(roles: readonly string[]): ViewScope | undefined {
  return roles.includes("ADMIN") ? viewScopeStore.getStore() : undefined;
}
