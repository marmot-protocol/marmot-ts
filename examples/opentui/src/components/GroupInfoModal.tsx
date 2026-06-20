import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { FormModal, type FormField } from "./FormModal.js";

const FIELDS: readonly FormField<"name" | "description">[] = [
  { key: "name", label: "name", placeholder: "group name" },
  {
    key: "description",
    label: "description",
    placeholder: "what this group is for",
  },
];

export function GroupInfoModal(props: {
  group: MarmotGroup;
  onSave: (fields: { name: string; description: string }) => void;
  onCancel: () => void;
}) {
  return (
    <FormModal<"name" | "description">
      title="edit group info"
      width={68}
      fields={FIELDS}
      initialValues={{
        name: props.group.groupData?.name ?? "",
        description: props.group.groupData?.description ?? "",
      }}
      saveLabel="Save group info"
      footer="admins only · Tab/↑↓: move · enter: save · esc: cancel"
      onSubmit={(fields) => props.onSave({ ...fields })}
      onCancel={props.onCancel}
    />
  );
}
