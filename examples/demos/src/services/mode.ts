import { BehaviorSubject } from "rxjs";

export type TransportMode = "local" | "live";

const MODE_KEY = "marmot-demos:mode";

function restoreMode(): TransportMode {
  try {
    return sessionStorage.getItem(MODE_KEY) === "live" ? "live" : "local";
  } catch (error) {
    console.error("Failed to restore session mode", error);
    return "local";
  }
}

/** The tab's persisted mode is deliberately writable; changing it replaces the transport. */
export const mode$ = new BehaviorSubject<TransportMode>(restoreMode());

mode$.subscribe((mode) => {
  try {
    sessionStorage.setItem(MODE_KEY, mode);
  } catch (error) {
    console.error("Failed to save session mode", error);
  }
});
