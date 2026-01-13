import { UserName } from "@/components/nostr-user";
import {
  getDisplayName,
  getProfilePicture,
  normalizeToPubkey,
} from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { useParams } from "react-router";
import { eventStore } from "@/lib/nostr";
import { PageHeader } from "../../components/page-header";

function ContactDetailContent({ pubkey }: { pubkey: string }) {
  const profile = use$(() => eventStore.profile(pubkey), [pubkey]);
  const displayName = getDisplayName(profile, pubkey.slice(0, 16));
  const picture = getProfilePicture(
    profile,
    `https://api.dicebear.com/7.x/identicon/svg?seed=${pubkey}`,
  );

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Contacts", to: "/contacts" },
          { label: displayName },
        ]}
      />
      <div className="flex items-center justify-center min-h-[400px] flex-col gap-4">
        <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full">
          <img
            src={picture}
            alt={displayName}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-semibold">
            <UserName pubkey={pubkey} />
          </h2>
        </div>
      </div>
    </>
  );
}

export default function ContactDetailPage() {
  const { npub } = useParams<{ npub: string }>();

  if (!npub) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid contact identifier</p>
        </div>
      </div>
    );
  }

  let pubkey: string;
  try {
    const hex = normalizeToPubkey(npub);
    if (!hex) throw new Error("Invalid npub");
    pubkey = hex;
  } catch (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid contact identifier</p>
        </div>
      </div>
    );
  }

  return <ContactDetailContent pubkey={pubkey} />;
}
