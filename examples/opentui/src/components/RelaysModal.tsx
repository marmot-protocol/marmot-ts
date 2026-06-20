import { parseRelays } from "../marmot/format.js";
import { FormModal, type FormField } from "./FormModal.js";

const FIELDS: readonly FormField<"outbox" | "inbox">[] = [
  {
    key: "outbox",
    label: "outbox relays — NIP-65 / kind 10002 (KeyPackage discovery)",
    placeholder: "wss://relay.one, wss://relay.two",
  },
  {
    key: "inbox",
    label: "inbox relays — kind 10050 (gift-wrapped welcome delivery)",
    placeholder: "wss://relay.one, wss://relay.two",
  },
];

/**
 * A modal form for editing the account's two advertised relay lists: the NIP-65
 * outbox list (kind 10002, where this account's KeyPackages are discoverable)
 * and the inbox list (kind 10050, where gift-wrapped welcomes are delivered).
 *
 * Each field is a whitespace/comma-separated list of relay URLs. Normalisation,
 * de-duplication, and dropping of invalid URLs happen in the controller, so this
 * component only has to split the text.
 */
export function RelaysModal(props: {
  outbox: string[];
  inbox: string[];
  onSave: (outbox: string[], inbox: string[]) => void;
  onCancel: () => void;
}) {
  return (
    <FormModal<"outbox" | "inbox">
      title="edit relay lists"
      width={74}
      fields={FIELDS}
      initialValues={{
        outbox: props.outbox.join(", "),
        inbox: props.inbox.join(", "),
      }}
      saveLabel="Save & publish"
      footer="Separate relays with spaces or commas · Tab/↑↓: move · enter: publish · esc: cancel"
      onSubmit={(values) =>
        props.onSave(parseRelays(values.outbox), parseRelays(values.inbox))
      }
      onCancel={props.onCancel}
    />
  );
}
