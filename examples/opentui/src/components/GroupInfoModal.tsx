import { useRef, useState } from "react";

import { useKeyboard } from "@opentui/react";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

const FIELDS = [
  { key: "name", label: "name", placeholder: "group name" },
  {
    key: "description",
    label: "description",
    placeholder: "what this group is for",
  },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Values = Record<FieldKey, string>;

export function GroupInfoModal(props: {
  group: MarmotGroup;
  onSave: (fields: Values) => void;
  onCancel: () => void;
}) {
  const initial = useRef<Values>({
    name: props.group.groupData?.name ?? "",
    description: props.group.groupData?.description ?? "",
  });
  const [values, setValues] = useState<Values>(initial.current);
  const [index, setIndex] = useState(0);
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
        width={68}
        flexDirection="column"
        title=" edit group info "
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
              Save group info
            </text>
          </box>
        </box>

        <text fg="#666">
          admins only · Tab/↑↓: move · enter: save · esc: cancel
        </text>
      </box>
    </box>
  );
}
