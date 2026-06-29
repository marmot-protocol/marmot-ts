import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { FormModal, type FormField } from "./FormModal.js";

type GroupInfoKey = "name" | "description" | "blossom";

const FIELDS: readonly FormField<GroupInfoKey>[] = [
  { key: "name", label: "name", placeholder: "group name" },
  {
    key: "description",
    label: "description",
    placeholder: "what this group is for",
  },
  {
    key: "blossom",
    label:
      "blossom servers — encrypted-media blob endpoints (group.encrypted-media.v1)",
    placeholder: "https://blossom.primal.net, https://cdn.example.com",
  },
];

/**
 * Splits the blossom-servers field into a list of base URLs, tolerating space-
 * or comma-separated input and a missing scheme (defaulting to `https://`).
 * Full validation/normalization happens in the encrypted-media codec; this only
 * has to produce candidate strings.
 */
export function parseBlossomServers(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (/^https?:\/\//i.test(entry) ? entry : `https://${entry}`));
}

export function GroupInfoModal(props: {
  group: MarmotGroup;
  onSave: (fields: {
    name: string;
    description: string;
    blossomServers: string[];
  }) => void;
  onCancel: () => void;
}) {
  const endpoints = props.group.groupData?.encryptedMedia?.defaultBlobEndpoints;
  return (
    <FormModal<GroupInfoKey>
      title="edit group info"
      width={78}
      fields={FIELDS}
      initialValues={{
        name: props.group.groupData?.name ?? "",
        description: props.group.groupData?.description ?? "",
        blossom: endpoints?.map((e) => e.baseUrl).join(", ") ?? "",
      }}
      saveLabel="Save group info"
      footer="admins only · Tab/↑↓: move · enter: save · esc: cancel"
      onSubmit={(fields) =>
        props.onSave({
          name: fields.name,
          description: fields.description,
          blossomServers: parseBlossomServers(fields.blossom),
        })
      }
      onCancel={props.onCancel}
    />
  );
}
