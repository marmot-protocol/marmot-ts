import { mapEventsToTimeline } from "applesauce-core";
import {
  getDisplayName,
  getProfilePicture,
  kinds,
  normalizeToPubkey,
  ProfileContent,
} from "applesauce-core/helpers";
import { ProfilePointer } from "applesauce-core/helpers/pointers";
import { PrimalCache } from "applesauce-extra";
import { onlyEvents } from "applesauce-relay";
import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { combineLatest, EMPTY, switchMap } from "rxjs";
import { useObservableMemo } from "../../hooks/use-observable";
import accounts, { contacts$ } from "../../lib/accounts";
import { eventStore, pool } from "../../lib/nostr";
import { lookupRelays$ } from "../../lib/settings";

/** Create a hook for loading a users profile */
function useProfile(user: ProfilePointer): ProfileContent | undefined {
  return useObservableMemo(
    () => eventStore.profile(user),
    [user.pubkey, user.relays?.join("|")],
  );
}

interface SearchResult {
  pubkey: string;
}

function SearchResultItem({
  pubkey,
  isHighlighted,
  onSelect,
  onMouseEnter,
}: {
  pubkey: string;
  isHighlighted: boolean;
  onSelect: (pubkey: string) => void;
  onMouseEnter: () => void;
}) {
  const profile = useProfile({ pubkey });

  const displayName = getDisplayName(profile, pubkey.slice(0, 8) + "...");
  const picture = getProfilePicture(
    profile,
    `https://robohash.org/${pubkey}.png`,
  );

  return (
    <li
      role="option"
      aria-selected={isHighlighted}
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
        isHighlighted ? "bg-base-200" : "hover:bg-base-200"
      }`}
      onClick={() => onSelect(pubkey)}
      onMouseEnter={onMouseEnter}
    >
      <div className="avatar">
        <div className="w-10 h-10 rounded-full">
          <img src={picture} alt={displayName} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{displayName}</div>
        <div className="text-sm text-base-content/60 font-mono truncate">
          {pubkey.slice(0, 16)}...
        </div>
      </div>
    </li>
  );
}

function UserSearchTab({ onSelect }: { onSelect: (pubkey: string) => void }) {
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const searchListboxRef = useRef<HTMLUListElement>(null);
  const primal = useMemo(() => new PrimalCache(), []);

  // Search function
  const performSearch = useCallback(
    async (query: string) => {
      if (!query.trim() || query.length < 2) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);

      try {
        const events = await primal.userSearch(query.trim(), 10);

        // Add events to store
        for (const event of events) {
          eventStore.add(event);
        }

        // Convert to search results (deduplicated)
        const seenPubkeys = new Set<string>();
        const results: SearchResult[] = [];
        for (const event of events) {
          if (seenPubkeys.has(event.pubkey)) continue;
          seenPubkeys.add(event.pubkey);
          results.push({ pubkey: event.pubkey });
        }

        setSearchResults(results);
        setHighlightedIndex(-1);
      } catch (error) {
        console.error("Search failed:", error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    },
    [primal],
  );

  // Debounced search effect
  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      performSearch(searchInput);
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [searchInput, performSearch]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (searchResults.length === 0) {
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev < searchResults.length - 1 ? prev + 1 : 0,
          );
          break;

        case "ArrowUp":
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : searchResults.length - 1,
          );
          break;

        case "Enter":
          event.preventDefault();
          if (
            highlightedIndex >= 0 &&
            highlightedIndex < searchResults.length
          ) {
            onSelect(searchResults[highlightedIndex].pubkey);
          }
          break;
      }
    },
    [searchResults, highlightedIndex, onSelect],
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && searchListboxRef.current) {
      const highlightedElement = searchListboxRef.current.children[
        highlightedIndex
      ] as HTMLElement;
      highlightedElement?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  return (
    <div className="space-y-4">
      <div className="relative">
        <input
          type="text"
          placeholder="Search for a user..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="input input-bordered w-full"
          autoFocus
        />
        {isSearching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <span className="loading loading-spinner loading-sm"></span>
          </div>
        )}
      </div>

      {searchResults.length > 0 && (
        <ul
          ref={searchListboxRef}
          className="bg-base-100 rounded-lg border border-base-300 max-h-80 overflow-y-auto"
        >
          {searchResults.map((result, index) => (
            <SearchResultItem
              key={result.pubkey}
              pubkey={result.pubkey}
              isHighlighted={index === highlightedIndex}
              onSelect={onSelect}
              onMouseEnter={() => setHighlightedIndex(index)}
            />
          ))}
        </ul>
      )}

      {searchInput.length >= 2 &&
        !isSearching &&
        searchResults.length === 0 && (
          <div className="text-center text-base-content/60 py-8">
            No results found
          </div>
        )}
    </div>
  );
}

function UserContactsTab({ onSelect }: { onSelect: (pubkey: string) => void }) {
  const contacts = useObservableMemo(() => contacts$, []);

  return (
    <div>
      {contacts && contacts.length > 0 ? (
        <ul className="space-y-1">
          {contacts.map((contact) => (
            <SearchResultItem
              key={contact.pubkey}
              pubkey={contact.pubkey}
              isHighlighted={false}
              onSelect={onSelect}
              onMouseEnter={() => {}}
            />
          ))}
        </ul>
      ) : (
        <div className="text-center text-base-content/60 py-8">
          No contacts found
        </div>
      )}
    </div>
  );
}

function AccountsTag({ onSelect }: { onSelect: (pubkey: string) => void }) {
  return (
    <div>
      {accounts.accounts.length > 0 ? (
        <ul className="space-y-1">
          {accounts.accounts.map((account) => (
            <SearchResultItem
              key={account.pubkey}
              pubkey={account.pubkey}
              isHighlighted={false}
              onSelect={onSelect}
              onMouseEnter={() => {}}
            />
          ))}
        </ul>
      ) : (
        <div className="text-center text-base-content/60 py-8">
          No accounts found
        </div>
      )}
    </div>
  );
}

function UserFollowersTab({
  onSelect,
}: {
  onSelect: (pubkey: string) => void;
}) {
  const followers = useObservableMemo(() => {
    return combineLatest([accounts.active$, lookupRelays$]).pipe(
      switchMap(([account, relays]) => {
        if (!account) return EMPTY;

        // Subscribe to kind 3 events on inbox relays
        return pool
          .subscription(relays, {
            kinds: [kinds.Contacts],
            "#p": [account.pubkey],
          })
          .pipe(onlyEvents(), mapEventsToTimeline());
      }),
    );
  }, []);

  return (
    <div>
      {followers && followers.length > 0 ? (
        <ul className="space-y-1">
          {followers.map((follower) => (
            <SearchResultItem
              key={follower.pubkey}
              pubkey={follower.pubkey}
              isHighlighted={false}
              onSelect={onSelect}
              onMouseEnter={() => {}}
            />
          ))}
        </ul>
      ) : (
        <div className="text-center text-base-content/60 py-8">
          {followers === undefined
            ? "Loading followers..."
            : "No followers found"}
        </div>
      )}
    </div>
  );
}

function UserSearchModal({
  isOpen,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (pubkey: string) => void;
}) {
  const account = useObservableMemo(() => accounts.active$, []);
  const [activeTab, setActiveTab] = useState<
    "search" | "contacts" | "accounts" | "followers"
  >("search");

  const handleModalSelect = (pubkey: string) => {
    onSelect(pubkey);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-2xl">
        <h3 className="font-bold text-lg mb-4">Select User</h3>

        {/* Tabs */}
        <div className="tabs tabs-border mb-4">
          <button
            className={`tab ${activeTab === "search" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("search")}
          >
            Search
          </button>
          <button
            className={`tab ${activeTab === "accounts" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("accounts")}
          >
            Accounts
          </button>
          {account && (
            <>
              <button
                className={`tab ${activeTab === "contacts" ? "tab-active" : ""}`}
                onClick={() => setActiveTab("contacts")}
              >
                Contacts
              </button>
              <button
                className={`tab ${activeTab === "followers" ? "tab-active" : ""}`}
                onClick={() => setActiveTab("followers")}
              >
                Followers
              </button>
            </>
          )}
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px] max-h-[500px] overflow-y-auto">
          {activeTab === "search" && (
            <UserSearchTab onSelect={handleModalSelect} />
          )}
          {activeTab === "contacts" && (
            <UserContactsTab onSelect={handleModalSelect} />
          )}
          {activeTab === "accounts" && (
            <AccountsTag onSelect={handleModalSelect} />
          )}
          {activeTab === "followers" && (
            <UserFollowersTab onSelect={handleModalSelect} />
          )}
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}

export default function UserSearch({
  onSelect,
  className,
  placeholder = "Search for a user...",
}: {
  onSelect: (pubkey: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState("");
  const [isValidPubkey, setIsValidPubkey] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const changeRef = useRef(onSelect);
  changeRef.current = onSelect;

  // Create PrimalCache instance
  const primal = useMemo(() => new PrimalCache(), []);

  // Search function
  const performSearch = useCallback(
    async (query: string) => {
      if (!query.trim() || query.length < 2) {
        setSearchResults([]);
        setIsOpen(false);
        return;
      }

      setIsSearching(true);

      try {
        const events = await primal.userSearch(query.trim(), 10);

        // Add events to store
        for (const event of events) {
          eventStore.add(event);
        }

        // Convert to search results (deduplicated)
        const seenPubkeys = new Set<string>();
        const results: SearchResult[] = [];
        for (const event of events) {
          if (seenPubkeys.has(event.pubkey)) continue;
          seenPubkeys.add(event.pubkey);
          results.push({ pubkey: event.pubkey });
        }

        setSearchResults(results);
        setIsOpen(results.length > 0);
        setHighlightedIndex(-1);
      } catch (error) {
        console.error("Search failed:", error);
        setSearchResults([]);
        setIsOpen(false);
      } finally {
        setIsSearching(false);
      }
    },
    [primal],
  );

  // Debounced search effect
  useEffect(() => {
    // Don't search if input is a valid pubkey
    if (isValidPubkey) {
      setSearchResults([]);
      setIsOpen(false);
      return;
    }

    const debounceTimer = setTimeout(() => {
      performSearch(inputValue);
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [inputValue, isValidPubkey, performSearch]);

  // Validate pubkey when input changes
  useEffect(() => {
    if (!inputValue.trim()) {
      setIsValidPubkey(false);
      return;
    }

    try {
      const normalizedPubkey = normalizeToPubkey(inputValue.trim());
      if (normalizedPubkey) {
        setIsValidPubkey(true);
        changeRef.current(normalizedPubkey);
      } else {
        setIsValidPubkey(false);
      }
    } catch {
      setIsValidPubkey(false);
    }
  }, [inputValue]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setHighlightedIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = useCallback((pubkey: string) => {
    setInputValue(pubkey);
    setIsOpen(false);
    setHighlightedIndex(-1);
    changeRef.current(pubkey);
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (!isOpen || searchResults.length === 0) {
        // Allow opening results on arrow down even if closed
        if (event.key === "ArrowDown" && searchResults.length > 0) {
          event.preventDefault();
          setIsOpen(true);
          setHighlightedIndex(0);
        }
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev < searchResults.length - 1 ? prev + 1 : 0,
          );
          break;

        case "ArrowUp":
          event.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : searchResults.length - 1,
          );
          break;

        case "Enter":
          event.preventDefault();
          if (
            highlightedIndex >= 0 &&
            highlightedIndex < searchResults.length
          ) {
            handleSelect(searchResults[highlightedIndex].pubkey);
          }
          break;

        case "Escape":
          event.preventDefault();
          setIsOpen(false);
          setHighlightedIndex(-1);
          break;

        case "Tab":
          setIsOpen(false);
          setHighlightedIndex(-1);
          break;
      }
    },
    [isOpen, searchResults, highlightedIndex, handleSelect],
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listboxRef.current) {
      const highlightedElement = listboxRef.current.children[
        highlightedIndex
      ] as HTMLElement;
      highlightedElement?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  const listboxId = "pubkey-picker-listbox";

  const handleModalSelect = (pubkey: string) => {
    setInputValue(pubkey);
    setIsValidPubkey(true);
    onSelect(pubkey);
    setIsModalOpen(false);
  };

  return (
    <>
      <div ref={containerRef} className={`relative w-full ${className ?? ""}`}>
        <div className="join w-full">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              placeholder={placeholder}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (searchResults.length > 0 && !isValidPubkey) {
                  setIsOpen(true);
                }
              }}
              role="combobox"
              aria-expanded={isOpen}
              aria-haspopup="listbox"
              aria-controls={listboxId}
              aria-activedescendant={
                highlightedIndex >= 0
                  ? `pubkey-option-${highlightedIndex}`
                  : undefined
              }
              aria-autocomplete="list"
              className={`input input-bordered join-item w-full pr-10 ${
                inputValue.trim() && !isValidPubkey
                  ? "input-warning"
                  : isValidPubkey
                    ? "input-success"
                    : ""
              }`}
            />

            {/* Loading indicator */}
            {isSearching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <span className="loading loading-spinner loading-sm"></span>
              </div>
            )}

            {/* Success indicator */}
            {!isSearching && isValidPubkey && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-success">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            )}
          </div>
          <button
            className="btn join-item"
            onClick={() => setIsModalOpen(true)}
          >
            More
          </button>
        </div>

        {/* Popover dropdown */}
        {isOpen && searchResults.length > 0 && (
          <div className="absolute z-50 w-full mt-1">
            <ul
              ref={listboxRef}
              id={listboxId}
              role="listbox"
              aria-label="Search results"
              className="bg-base-100 rounded-lg shadow-lg border border-base-300 max-h-80 overflow-y-auto"
            >
              {searchResults.map((result, index) => (
                <SearchResultItem
                  key={result.pubkey}
                  pubkey={result.pubkey}
                  isHighlighted={index === highlightedIndex}
                  onSelect={handleSelect}
                  onMouseEnter={() => setHighlightedIndex(index)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* Helper text */}
        {inputValue.trim() && !isValidPubkey && !isOpen && !isSearching && (
          <label className="label pt-1 pb-0">
            <span className="label-text-alt text-base-content/60">
              Type to search or enter a valid pubkey/npub
            </span>
          </label>
        )}
      </div>

      <UserSearchModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={handleModalSelect}
      />
    </>
  );
}
