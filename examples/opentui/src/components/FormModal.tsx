import { useRef, useState, type ReactNode } from "react";

import { useKeyboard } from "@opentui/react";

import { ModalOverlay, theme } from "./primitives.js";

export type FormField<K extends string> = {
  key: K;
  label: string;
  placeholder?: string;
};

/**
 * A modal form with vertically stacked single-line fields and a save button.
 * Tab/↑/↓ cycle through the fields and the save button, Enter on the save button
 * submits, Esc cancels. Inputs are seeded once from `initialValues` and tracked
 * uncontrolled so the cursor stays stable while typing.
 *
 * Backs ProfileModal, RelaysModal, GroupInfoModal and NewAccountModal, which
 * differ only in their field set, labels, and the submit transform (trimming /
 * relay parsing) they apply in their own `onSubmit`.
 */
export function FormModal<K extends string>(props: {
  title: string;
  width: number;
  fields: readonly FormField<K>[];
  initialValues: Record<K, string>;
  saveLabel: string;
  footer: string;
  /** Optional intro/explanation rendered above the fields. */
  header?: ReactNode;
  onSubmit: (values: Record<K, string>) => void;
  onCancel: () => void;
}) {
  const initial = useRef<Record<K, string>>(props.initialValues);
  const [values, setValues] = useState<Record<K, string>>(initial.current);
  const [index, setIndex] = useState(0); // 0..fields.length (last = save)
  const total = props.fields.length + 1;
  const saveIndex = props.fields.length;

  const save = () => props.onSubmit(values);

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
    <ModalOverlay title={props.title} width={props.width} footer={props.footer}>
      {props.header}
      {props.fields.map((field, i) => (
        <box key={field.key} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
          <text fg={index === i ? theme.accent : theme.labelActive}>
            {field.label}
          </text>
          <box
            border
            borderColor={index === i ? theme.accent : theme.border}
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
          borderColor={index === saveIndex ? theme.accent : theme.borderDim}
          backgroundColor={index === saveIndex ? "#2a2a40" : "#13131d"}
          onMouseDown={() => save()}
        >
          <text fg={index === saveIndex ? theme.accent : "#cccccc"}>
            {props.saveLabel}
          </text>
        </box>
      </box>
    </ModalOverlay>
  );
}
