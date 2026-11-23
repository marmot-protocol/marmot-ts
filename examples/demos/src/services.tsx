import { EventStore } from "applesauce-core";
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
import type { DemoTransport, TransportMode } from "./lib/transport.js";
import {
  getDevelopmentName,
  publishDevelopmentProfile,
} from "./lib/development-identity.js";
import { SessionClient } from "./lib/session-client.js";

export type DemoServices = {
  mode: TransportMode;
  store: EventStore;
  transport: DemoTransport;
  contacts: ContactsService;
  session: SessionClient;
};

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
      controller.abort();
      session?.close();
      transport.close();
    };
    addEventListener("pagehide", unload);
    void SessionClient.create(account, mode, transport).then(
      (value) => {
        session = value;
        if (controller.signal.aborted) {
          session.close();
          return;
        }
        setServices({ mode, store, transport, contacts, session });
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
      contacts.close();
      controller.abort();
      session?.close();
      transport.close();
      store.dispose();
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
