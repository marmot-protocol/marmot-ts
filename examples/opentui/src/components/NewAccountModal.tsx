import { parseRelays } from "../marmot/format.js";
import { FormModal, type FormField } from "./FormModal.js";

/** The relay this UI suggests for a brand-new account's inbox + outbox lists. */
export const DEFAULT_NEW_ACCOUNT_RELAYS = "relay.us.whitenoise.chat";

const FIELDS: readonly FormField<"name" | "relays">[] = [
  {
    key: "name",
    label: "display name",
    placeholder: "how you appear to others (kind 0 profile)",
  },
  {
    key: "relays",
    label: "relays — used as both your inbox & outbox (optional)",
    placeholder: DEFAULT_NEW_ACCOUNT_RELAYS,
  },
];

/**
 * Collects the details for a fresh account before it is created: a profile name
 * and an optional relay list used for both the NIP-65 outbox (kind 10002) and
 * the welcome inbox (kind 10050). The relay field is pre-seeded with
 * {@link DEFAULT_NEW_ACCOUNT_RELAYS}; leaving it untouched keeps that default.
 * Normalisation and de-duplication of the relays happen downstream.
 */
export function NewAccountModal(props: {
  onSubmit: (params: { name: string; relays: string[] }) => void;
  onCancel: () => void;
}) {
  return (
    <FormModal<"name" | "relays">
      title="create a new account"
      width={74}
      fields={FIELDS}
      initialValues={{ name: "", relays: DEFAULT_NEW_ACCOUNT_RELAYS }}
      saveLabel="Create account"
      footer="Separate relays with spaces or commas · Tab/↑↓: move · enter: create · esc: cancel"
      header={
        <>
          <text fg="#9aa9b8">
            Logs out of the current account and generates a fresh identity.
          </text>
          <box height={1} />
        </>
      }
      onSubmit={(values) =>
        props.onSubmit({
          name: values.name.trim(),
          relays: parseRelays(values.relays),
        })
      }
      onCancel={props.onCancel}
    />
  );
}
