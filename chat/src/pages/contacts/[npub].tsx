import { UserName } from "@/components/nostr-user";
import { eventStore } from "@/lib/nostr";
import { castUser, User } from "applesauce-common/casts/user";
import { normalizeToPubkey } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { useParams } from "react-router";
import FollowButton from "../../components/follow-button";
import { PageHeader } from "../../components/page-header";

function ContactDetailContent({ user }: { user: User }) {
  const profile = use$(user.profile$);
  const displayName = profile?.displayName;
  const picture =
    profile?.picture ||
    `https://api.dicebear.com/7.x/identicon/svg?seed=${user.pubkey}`;

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Contacts", to: "/contacts" },
          { label: displayName ?? "" },
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
            <UserName pubkey={user.pubkey} />
          </h2>
          <FollowButton pubkey={user.pubkey} size="lg" />
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

  let user: User;
  try {
    const hex = normalizeToPubkey(npub);
    if (!hex) throw new Error("Invalid npub");
    user = castUser(hex, eventStore);
  } catch (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid contact identifier</p>
        </div>
      </div>
    );
  }

  return <ContactDetailContent user={user} />;
}
