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
import { DemoRelay } from "./lib/demo-relay.js";
import { LiveTransport } from "./lib/live-transport.js";
import type { DemoTransport, TransportMode } from "./lib/transport.js";
import { publishDevelopmentProfile } from "./lib/development-identity.js";

export type DemoServices = {
  mode: TransportMode;
  store: EventStore;
  transport: DemoTransport;
  contacts: ContactsService;
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
  useEffect(() => {
    const store = new EventStore();
    const transport =
      mode === "local" ? new DemoRelay() : new LiveTransport(store);
    if (transport instanceof DemoRelay) transport.setIdentity(account.pubkey);
    const contacts = new ContactsService(account.pubkey, transport, store);
    const controller = new AbortController();
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
      transport.close();
    };
    addEventListener("pagehide", unload);
    setServices({ mode, store, transport, contacts });
    return () => {
      removeEventListener("pagehide", unload);
      contacts.close();
      controller.abort();
      transport.close();
      store.dispose();
    };
  }, [mode, account]);
  if (!services) return null;
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
