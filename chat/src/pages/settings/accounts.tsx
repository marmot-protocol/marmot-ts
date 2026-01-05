import { UserAvatar, UserName } from "@/components/nostr-user";
import QRButton from "@/components/qr-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import accountManager from "@/lib/accounts";
import { npubEncode } from "applesauce-core/helpers/pointers";
import { use$ } from "applesauce-react/hooks";
import { useState } from "react";
import { Link, useLocation } from "react-router";

function AccountItem({
  account,
  isActive,
  onSwitch,
  onRemove,
}: {
  account: { id: string; pubkey: string };
  isActive: boolean;
  onSwitch: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar pubkey={account.pubkey} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">
          <UserName pubkey={account.pubkey} />
        </div>
        <code className="text-xs text-muted-foreground truncate select-all font-mono block">
          {account.pubkey}
        </code>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <QRButton
            data={npubEncode(account.pubkey)}
            label="npub"
            variant="ghost"
            size="sm"
          />
          <QRButton
            data={account.pubkey}
            label="hex"
            variant="ghost"
            size="sm"
          />
        </div>
        <Button
          variant={isActive ? "default" : "outline"}
          size="sm"
          onClick={onSwitch}
          disabled={isActive}
        >
          Switch
        </Button>
        <Button variant="destructive" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

export default function SettingsAccountsPage() {
  const location = useLocation();
  const accounts = use$(accountManager.accounts$) || [];
  const activeAccount = use$(accountManager.active$);
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null);

  const handleSwitchAccount = (accountId: string) => {
    accountManager.setActive(accountId);
  };

  const handleRemoveAccount = (accountId: string) => {
    setRemoveAccountId(accountId);
  };

  const confirmRemoveAccount = () => {
    if (removeAccountId) {
      accountManager.removeAccount(removeAccountId);
      setRemoveAccountId(null);
    }
  };

  return (
    <div className="w-full max-w-2xl space-y-8 p-4">
      <div className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold">Accounts</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your accounts. Switch between accounts or add new ones.
          </p>
        </div>
        <div className="space-y-2">
          {accounts.length === 0 ? (
            <div className="text-muted-foreground text-sm text-center py-8">
              No accounts configured. Add an account to get started.
            </div>
          ) : (
            accounts.map((account) => {
              const isActive = activeAccount?.id === account.id;
              return (
                <AccountItem
                  key={account.id}
                  account={account}
                  isActive={isActive}
                  onSwitch={() => handleSwitchAccount(account.id)}
                  onRemove={() => handleRemoveAccount(account.id)}
                />
              );
            })
          )}
        </div>

        <div className="flex gap-2 w-full">
          <Button asChild className="flex-1">
            <Link
              to={{ pathname: "/signin", search: `?to=${location.pathname}` }}
            >
              Add Account
            </Link>
          </Button>
        </div>
      </div>

      <AlertDialog
        open={removeAccountId !== null}
        onOpenChange={(open) => !open && setRemoveAccountId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this account? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemoveAccount}
              variant="destructive"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
