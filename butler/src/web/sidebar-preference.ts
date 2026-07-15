export const SIDEBAR_COLLAPSED_STORAGE_KEY = "manor.sidebar.collapsed";

export type SidebarPreferenceStore = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

export function readSidebarCollapsed(store?: SidebarPreferenceStore): boolean {
  try {
    const preferenceStore = store ?? (typeof window === "undefined" ? null : window.localStorage);
    return preferenceStore?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean, store?: SidebarPreferenceStore): void {
  try {
    const preferenceStore = store ?? (typeof window === "undefined" ? null : window.localStorage);
    preferenceStore?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // The layout still works when browser storage is unavailable.
  }
}
