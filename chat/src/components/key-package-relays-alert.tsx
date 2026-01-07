import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Link } from "react-router";

/**
 * Reusable alert component that directs users to set up their key package relays
 * when they haven't configured them yet.
 */
export function KeyPackageRelaysAlert() {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Key Package Relays Not Configured</AlertTitle>
      <AlertDescription className="mt-2">
        <p className="mb-3">
          You need to configure your key package relays before creating a key
          package. This tells other users which relays to check for your key
          packages.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/marmot">Configure Key Package Relays</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
