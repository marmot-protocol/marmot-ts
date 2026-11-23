import { BehaviorSubject } from "rxjs";

export type TransportMode = "local" | "live";

/** The tab's mode is deliberately writable; changing it replaces the service scope. */
export const mode$ = new BehaviorSubject<TransportMode>("local");
