import { getDisplayName, getProfilePicture } from "applesauce-core/helpers";
import { use$ } from "applesauce-react/hooks";
import { eventStore } from "../lib/nostr";
import { cn } from "../lib/utils";

export function UserName(props: { pubkey: string }) {
  const profile = use$(() => eventStore.profile(props.pubkey), [props.pubkey]);

  return <>{getDisplayName(profile, props.pubkey.slice(0, 16))}</>;
}

export type UserAvatarSize = "sm" | "md" | "lg" | "xl";

const sizeClasses: Record<UserAvatarSize, string> = {
  sm: "w-6 h-6",
  md: "w-10 h-10",
  lg: "w-12 h-12",
  xl: "w-14 h-14",
};

export function UserAvatar({
  pubkey,
  size = "md",
}: {
  pubkey: string;
  size?: UserAvatarSize;
}) {
  const profile = use$(() => eventStore.profile(pubkey), [pubkey]);

  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-full",
        sizeClasses[size],
      )}
    >
      <img
        src={getProfilePicture(
          profile,
          `https://api.dicebear.com/7.x/identicon/svg?seed=${pubkey}`,
        )}
        alt="avatar"
        className="h-full w-full object-cover"
      />
    </div>
  );
}
