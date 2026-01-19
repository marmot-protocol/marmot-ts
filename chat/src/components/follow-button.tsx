import { FollowUser, UnfollowUser } from "applesauce-actions/actions";
import { use$ } from "applesauce-react/hooks";
import { VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { actions, user$ } from "../lib/accounts";
import { Button, buttonVariants } from "./ui/button";

export default function FollowButton({
  pubkey,
  ...props
}: { pubkey: string } & VariantProps<typeof buttonVariants>) {
  const contacts = use$(user$.contacts$);
  const isFollowing =
    useMemo(
      () => contacts?.some((c) => c.pubkey === pubkey),
      [contacts, pubkey],
    ) || false;
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    setLoading(true);

    try {
      await actions.run(isFollowing ? UnfollowUser : FollowUser, pubkey);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button onClick={handleClick} disabled={loading} {...props}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {isFollowing ? "Unfollow" : "Follow"}
    </Button>
  );
}
