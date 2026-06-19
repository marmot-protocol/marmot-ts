import { useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

/** The relay this UI suggests for a brand-new account's inbox + outbox lists. */
export const DEFAULT_NEW_ACCOUNT_RELAYS = "relay.us.whitenoise.chat";

const FIELDS = [
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
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Values = Record<FieldKey, string>;

/** Split a free-form field into relay URLs (whitespace/comma separated). */
function parseRelays(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * Collects the details for a fresh account before it is created: a profile name
 * and an optional relay list used for both the NIP-65 outbox (kind 10002) and
 * the welcome inbox (kind 10050). The relay field is pre-seeded with
 * {@link DEFAULT_NEW_ACCOUNT_RELAYS}; leaving it untouched keeps that default.
 *
 * Tab/↑/↓ move between fields, Enter creates the account, Esc cancels.
 * Normalisation and de-duplication of the relays happen downstream (the
 * controller's `normalizeRelays`), so this component only splits the text.
 */
export function NewAccountModal(props: {
  onSubmit: (params: { name: string; relays: string[] }) => void;
  onCancel: () => void;
}) {
  const initial = useRef<Values>({
    name: "",
    relays: DEFAULT_NEW_ACCOUNT_RELAYS,
  });
  const [values, setValues] = useState<Values>(initial.current);
  const [index, setIndex] = useState(0); // 0..FIELDS.length (last = Create)
  const total = FIELDS.length + 1;
  const createIndex = FIELDS.length;

  const submit = () =>
    props.onSubmit({
      name: values.name.trim(),
      relays: parseRelays(values.relays),
    });

  useKeyboard((key) => {
    if (key.name === "escape") return props.onCancel();
    if (key.name === "tab") {
      setIndex((i) => (i + (key.shift ? total - 1 : 1)) % total);
    } else if (key.name === "down") {
      setIndex((i) => (i + 1) % total);
    } else if (key.name === "up") {
      setIndex((i) => (i + total - 1) % total);
    } else if (
      (key.name === "return" || key.name === "enter") &&
      index === createIndex
    ) {
      submit();
    }
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      shouldFill={false}
      justifyContent="center"
      alignItems="center"
    >
      <box
        border
        borderColor="#FFD700"
        backgroundColor="#15151f"
        padding={1}
        width={74}
        flexDirection="column"
        title=" create a new account "
      >
        <text fg="#9aa9b8">
          Logs out of the current account and generates a fresh identity.
        </text>
        <box height={1} />

        {FIELDS.map((field, i) => (
          <box
            key={field.key}
            flexDirection="column"
            marginTop={i === 0 ? 0 : 1}
          >
            <text fg={index === i ? "#FFD700" : "#888"}>{field.label}</text>
            <box
              border
              borderColor={index === i ? "#FFD700" : "#444"}
              paddingX={1}
              height={3}
            >
              <input
                value={initial.current[field.key]}
                focused={index === i}
                placeholder={field.placeholder}
                onInput={(value: string) =>
                  setValues((prev) => ({ ...prev, [field.key]: value }))
                }
                onSubmit={(() => submit()) as any}
              />
            </box>
          </box>
        ))}

        <box marginTop={1} flexDirection="row">
          <box
            border
            height={3}
            paddingX={1}
            borderColor={index === createIndex ? "#FFD700" : "#555"}
            backgroundColor={index === createIndex ? "#2a2a40" : "#13131d"}
            onMouseDown={() => submit()}
          >
            <text fg={index === createIndex ? "#FFD700" : "#cccccc"}>
              Create account
            </text>
          </box>
        </box>

        <text fg="#666">
          Separate relays with spaces or commas · Tab/↑↓: move · enter: create ·
          esc: cancel
        </text>
      </box>
    </box>
  );
}
