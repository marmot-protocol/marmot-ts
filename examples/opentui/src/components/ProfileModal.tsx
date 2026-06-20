import type { ProfileContent } from "applesauce-core/helpers/profile";

import { FormModal, type FormField } from "./FormModal.js";

const FIELDS: readonly FormField<keyof ProfileFields & string>[] = [
  { key: "name", label: "name", placeholder: "your handle" },
  { key: "about", label: "about", placeholder: "short bio" },
  { key: "picture", label: "picture", placeholder: "https://… avatar url" },
  { key: "nip05", label: "nip05", placeholder: "you@example.com" },
];

type ProfileFields = {
  name: string;
  about: string;
  picture: string;
  nip05: string;
};

/**
 * A modal form for editing the user's kind 0 profile (NIP-01 metadata).
 * Tab/↑/↓ move between fields, Enter saves & publishes, Esc cancels.
 */
export function ProfileModal(props: {
  profile: ProfileContent | null;
  onSave: (fields: ProfileContent) => void;
  onCancel: () => void;
}) {
  return (
    <FormModal<keyof ProfileFields & string>
      title="edit profile (kind 0)"
      width={64}
      fields={FIELDS}
      initialValues={{
        name: props.profile?.name ?? "",
        about: props.profile?.about ?? "",
        picture: props.profile?.picture ?? "",
        nip05: props.profile?.nip05 ?? "",
      }}
      saveLabel="Save & publish"
      footer="Tab/↑↓: move · enter: save · esc: cancel"
      onSubmit={(fields) => props.onSave({ ...fields })}
      onCancel={props.onCancel}
    />
  );
}
