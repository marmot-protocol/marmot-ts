import { Observable, distinctUntilChanged, shareReplay, takeUntil } from "rxjs";

/** Also stops late subscribers from starting work after disposal. */
export function aborted$(signal: AbortSignal): Observable<void> {
  return new Observable((subscriber) => {
    if (signal.aborted) {
      subscriber.next();
      subscriber.complete();
      return;
    }
    const abort = () => {
      subscriber.next();
      subscriber.complete();
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  });
}

/** One current-state subscription, shared by all consumers while observed. */
export function stateObservable<T>(
  read: () => T,
  listen: (changed: () => void) => () => void,
  lifetime: AbortSignal,
  equal: (a: T, b: T) => boolean = Object.is,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const changed = () => {
      try {
        subscriber.next(read());
      } catch (cause) {
        subscriber.error(cause);
      }
    };
    subscriber.add(listen(changed));
    changed();
  }).pipe(
    distinctUntilChanged(equal),
    takeUntil(aborted$(lifetime)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}
