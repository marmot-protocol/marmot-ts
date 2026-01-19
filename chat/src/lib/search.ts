import { getDisplayName, getProfileContent } from "applesauce-core/helpers";
import Fuse from "fuse.js";
import { eventStore } from "./nostr";

export type ProfileSearchResult = {
  pubkey: string;
  name?: string;
  display_name?: string;
  about?: string;
};

// Create global profile search index
export const profileSearch = new Fuse<ProfileSearchResult>([], {
  keys: ["name", "display_name", "about"],
});

// Add all profiles to the search index
eventStore.filters({ kinds: [0] }).subscribe((event) => {
  const profile = getProfileContent(event);
  if (!profile) return;

  profileSearch.add({
    pubkey: event.pubkey,
    name: profile.name,
    display_name: getDisplayName(profile),
    about: profile.about,
  });
});
