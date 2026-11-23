import { use$ } from "applesauce-react/hooks";
import type { User } from "applesauce-common/casts";
import { useContacts } from "../services.js";
import { short } from "../lib/ui.js";

export function Contacts() {
  const service = useContacts();
  const contacts = use$(service.contacts$) ?? [];
  const error = use$(service.error$);
  return (
    <section className="border-t border-base-300 p-4">
      <h2 className="mb-2 text-sm font-semibold">
        Contacts ({contacts.length})
      </h2>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <ul className="max-h-48 overflow-y-auto text-sm">
        {contacts.map((user) => (
          <Contact key={user.pubkey} user={user} />
        ))}
      </ul>
      {!contacts.length && (
        <p className="text-xs text-base-content/50">No contacts</p>
      )}
    </section>
  );
}

function Contact({ user }: { user: User }) {
  const profile = use$(() => user.profile$, [user]);
  return (
    <li className="truncate py-1" title={user.npub}>
      {profile?.displayName || short(user.pubkey)}
    </li>
  );
}
