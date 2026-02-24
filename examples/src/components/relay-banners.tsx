import { useObservable } from "../hooks/use-observable";
import accounts, { keyPackageRelays$, mailboxes$ } from "../lib/accounts";

type RelayBannersProps = {
  /** When true, show the NIP-65 banner (missing inbox/outbox relays). */
  showNip65?: boolean;
  /** When true, show the KeyPackage relay-list banner (missing kind 10051). */
  showKeyPackageRelayList?: boolean;
};

export function RelayBanners({
  showNip65 = true,
  showKeyPackageRelayList = true,
}: RelayBannersProps) {
  const account = useObservable(accounts.active$);
  const mailboxes = useObservable(mailboxes$);
  const keyPackageRelays = useObservable(keyPackageRelays$);

  const hasNip65 = Boolean(
    mailboxes &&
    (mailboxes.inboxes?.length || 0) > 0 &&
    (mailboxes.outboxes?.length || 0) > 0,
  );

  const has10051 = Boolean(keyPackageRelays && keyPackageRelays.length > 0);

  // Determine if any banner should be shown
  const showNip65Banner = showNip65 && !hasNip65;
  const showKeyPackageBanner = showKeyPackageRelayList && hasNip65 && !has10051;

  if (!account || (!showNip65Banner && !showKeyPackageBanner)) return null;

  return (
    <div className="p-4 space-y-3">
      {showNip65 && !hasNip65 && (
        <div className="alert alert-warning">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="stroke-current shrink-0 h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
            />
          </svg>
          <div className="flex-1">
            <div className="font-semibold">
              Missing NIP-65 relay list (kind 10002)
            </div>
            <div className="text-sm">
              Configure and publish your read/write relays so others can
              reliably deliver invites (giftwraps) and discover your metadata.
            </div>
          </div>
          <a className="btn btn-sm btn-primary" href="#settings">
            Open Settings
          </a>
        </div>
      )}

      {showKeyPackageRelayList && hasNip65 && !has10051 && (
        <div className="alert alert-warning">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="stroke-current shrink-0 h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"
            />
          </svg>
          <div className="flex-1">
            <div className="font-semibold">
              Missing Key Package relay list (kind 10051)
            </div>
            <div className="text-sm">
              Publish a 10051 relay list so others can discover where to fetch
              your key packages (kind 443) for inviting you.
            </div>
          </div>
          <a className="btn btn-sm btn-primary" href="#key-package/relay-list">
            Configure 10051
          </a>
        </div>
      )}
    </div>
  );
}
