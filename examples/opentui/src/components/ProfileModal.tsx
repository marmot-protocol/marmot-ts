import { useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";
import type { ProfileContent } from "applesauce-core/helpers/profile";

const FIELDS = [
  { key: "name", label: "name", placeholder: "your handle" },
  { key: "about", label: "about", placeholder: "short bio" },
  { key: "picture", label: "picture", placeholder: "https://… avatar url" },
  { key: "nip05", label: "nip05", placeholder: "you@example.com" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Values = Record<FieldKey, string>;

/**
 * A modal form for editing the user's kind 0 profile (NIP-01 metadata).
 * Tab/↑/↓ move between fields, Enter saves & publishes, Esc cancels. Inputs are
 * seeded once with the current profile and tracked uncontrolled to keep the
 * cursor stable while typing.
 */
export function ProfileModal(props: {
  profile: ProfileContent | null;
  onSave: (fields: ProfileContent) => void;
  onCancel: () => void;
}) {
  const initial = useRef<Values>({
    name: props.profile?.name ?? "",
    about: props.profile?.about ?? "",
    picture: props.profile?.picture ?? "",
    nip05: props.profile?.nip05 ?? "",
  });
  const [values, setValues] = useState<Values>(initial.current);
  const [index, setIndex] = useState(0); // 0..FIELDS.length (last = Save)
  const total = FIELDS.length + 1;
  const saveIndex = FIELDS.length;

  const save = () => props.onSave({ ...values });

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
        width={64}
        flexDirection="column"
        title=" edit profile (kind 0) "
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

        <text fg="#666">Tab/↑↓: move · enter: save · esc: cancel</text>
      </box>
    </box>
  );
}
