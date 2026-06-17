import { useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

const FIELDS = [
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
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Values = Record<FieldKey, string>;

/** Split a free-form field into relay URLs (whitespace/comma separated). */
function parseRelays(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * A modal form for editing the account's two advertised relay lists: the NIP-65
 * outbox list (kind 10002, where this account's KeyPackages are discoverable)
 * and the inbox list (kind 10050, where gift-wrapped welcomes are delivered).
 *
 * Each field is a whitespace/comma-separated list of relay URLs, seeded once
 * with the currently-published list. Tab/↑/↓ move between fields, Enter
 * publishes both lists, Esc cancels. Normalisation, de-duplication, and
 * dropping of invalid URLs happen in the controller (`relaySet` + the marmot-ts
 * event builders), so this component only has to split the text.
 */
export function RelaysModal(props: {
  outbox: string[];
  inbox: string[];
  onSave: (outbox: string[], inbox: string[]) => void;
  onCancel: () => void;
}) {
  const initial = useRef<Values>({
    outbox: props.outbox.join(", "),
    inbox: props.inbox.join(", "),
  });
  const [values, setValues] = useState<Values>(initial.current);
  const [index, setIndex] = useState(0); // 0..FIELDS.length (last = Save)
  const total = FIELDS.length + 1;
  const saveIndex = FIELDS.length;

  const save = () =>
    props.onSave(parseRelays(values.outbox), parseRelays(values.inbox));

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
      index === saveIndex
    ) {
      save();
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
        title=" edit relay lists "
      >
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
                onSubmit={(() => save()) as any}
              />
            </box>
          </box>
        ))}

        <box marginTop={1} flexDirection="row">
          <box
            border
            height={3}
            paddingX={1}
            borderColor={index === saveIndex ? "#FFD700" : "#555"}
            backgroundColor={index === saveIndex ? "#2a2a40" : "#13131d"}
            onMouseDown={() => save()}
          >
            <text fg={index === saveIndex ? "#FFD700" : "#cccccc"}>
              Save &amp; publish
            </text>
          </box>
        </box>

        <text fg="#666">
          Separate relays with spaces or commas · Tab/↑↓: move · enter: publish
          · esc: cancel
        </text>
      </box>
    </box>
  );
}
