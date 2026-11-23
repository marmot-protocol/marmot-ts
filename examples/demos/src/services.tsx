import { EventStore } from "applesauce-core";
import { castUser, type Profile, type User } from "applesauce-common/casts";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAccount } from "./accounts.js";
import { ContactsService } from "./lib/contacts.js";
import { DemoRelay } from "./services/relay/demo-relay.js";
import { LiveTransport } from "./lib/live-transport.js";
import type { TransportMode } from "./lib/transport.js";
import {
  getDevelopmentName,
  publishDevelopmentProfile,
} from "./lib/development-identity.js";
import { SessionClient, type SessionKeyState } from "./lib/session-client.js";
import type { IAccount } from "applesauce-accounts";
import { of, takeUntil, type Observable } from "rxjs";
import { aborted$ } from "./lib/observable.js";
import { reactiveClient, type ReactiveClient } from "./lib/reactive-client.js";
import {
  reactiveTransport,
  type ReactiveTransport,
} from "./lib/reactive-transport.js";

/** Observable-only read boundary; concrete service lifecycles stay in this provider. */
export type DemoServices = Readonly<{
  mode$: Observable<TransportMode>;
  transport: ReactiveTransport;
  contacts: {
    readonly contacts$: Observable<User[]>;
    readonly error$: Observable<string | undefined>;
  };
  client: ReactiveClient;
  account$: Observable<IAccount>;
  profile$: (pubkey: string) => Observable<Profile | undefined>;
  outboxes$: (pubkey: string) => Observable<string[] | undefined>;
  signal: AbortSignal;
  keyPublication: Pick<SessionClient, "publish" | "rotate"> & {
    readonly state$: Observable<SessionKeyState>;
  };
}>;

const ServicesContext = createContext<DemoServices | undefined>(undefined);

export function ServicesProvider({
  mode,
  children,
}: {
  mode: TransportMode;
  children: ReactNode;
}) {
  const account = useAccount();
  const [services, setServices] = useState<DemoServices>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const store = new EventStore();
    const transport =
      mode === "local" ? new DemoRelay() : new LiveTransport(store);
    if (transport instanceof DemoRelay) transport.setIdentity(account.pubkey);
    const contacts = new ContactsService(account.pubkey, transport, store);
    const controller = new AbortController();
    let session: SessionClient | undefined;
    if (transport instanceof DemoRelay) {
      void publishDevelopmentProfile(
        account,
        transport,
        controller.signal,
      ).catch((cause: unknown) => {
        if (!controller.signal.aborted)
          contacts.error$.next(
            cause instanceof Error ? cause.message : String(cause),
          );
      });
    }
    const unload = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      contacts.close();
      session?.close();
      transport.close();
      store.dispose();
    };
    addEventListener("pagehide", unload);
    void SessionClient.create(account, mode, transport).then(
      (value) => {
        session = value;
        if (controller.signal.aborted) {
          session.close();
          return;
        }
        setServices({
          mode$: of(mode).pipe(takeUntil(aborted$(controller.signal))),
          transport: reactiveTransport(transport, controller.signal),
          contacts: {
            contacts$: contacts.contacts$.asObservable(),
            error$: contacts.error$.asObservable(),
          },
          client: reactiveClient(session.client, controller.signal),
          account$: of(account).pipe(takeUntil(aborted$(controller.signal))),
          profile$: (pubkey) =>
            castUser(pubkey, store).profile$.pipe(
              takeUntil(aborted$(controller.signal)),
            ),
          outboxes$: (pubkey) =>
            castUser(pubkey, store).outboxes$.pipe(
              takeUntil(aborted$(controller.signal)),
            ),
          signal: session.signal,
          keyPublication: {
            state$: session.state$.asObservable(),
            publish: session.publish,
            rotate: session.rotate,
          },
        });
        void session
          .start(mode === "local" && !!getDevelopmentName(account))
          .catch(() => {
            // Key-package errors are shown beside the sidebar controls.
          });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      removeEventListener("pagehide", unload);
      unload();
    };
  }, [mode, account]);
  if (error)
    return (
      <p role="alert" className="p-4 text-error">
        {error}
      </p>
    );
  if (!services) return <span className="loading loading-spinner m-4" />;
  return (
    <ServicesContext.Provider value={services}>
      {children}
    </ServicesContext.Provider>
  );
}

export function useDemoServices(): DemoServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("Demo services are not available");
  return services;
}

export const useTransport = () => useDemoServices().transport;
export const useContacts = () => useDemoServices().contacts;
