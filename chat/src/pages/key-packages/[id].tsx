import { use$ } from "applesauce-react/hooks";
import {
  getKeyPackage,
  getKeyPackageCipherSuiteId,
  getKeyPackageClient,
  KEY_PACKAGE_KIND,
} from "marmot-ts";
import { useParams } from "react-router";
import { of, switchMap } from "rxjs";

import CipherSuiteBadge from "@/components/cipher-suite-badge";
import KeyPackageDataView from "@/components/data-view/key-package";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { eventStore } from "@/lib/nostr";
import { formatTimeAgo } from "@/lib/time";

export default function KeyPackageDetailPage() {
  const { id } = useParams<{ id: string }>();

  const event = use$(
    () =>
      id
        ? eventStore
            .timeline({
              kinds: [KEY_PACKAGE_KIND],
            })
            .pipe(
              switchMap((events) => {
                const found = events.find((e) => e.id === id);
                return found ? of(found) : of(null);
              }),
            )
        : of(null),
    [id],
  );

  if (!id) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Invalid key package identifier</p>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>Key package not found</p>
        </div>
      </div>
    );
  }

  const cipherSuiteId = getKeyPackageCipherSuiteId(event);
  const client = getKeyPackageClient(event);
  const timeAgo = formatTimeAgo(event.created_at);

  let keyPackage;
  try {
    keyPackage = getKeyPackage(event);
  } catch (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center text-muted-foreground">
          <p>
            Error parsing key package:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Key Package Details</h1>
        <p className="text-muted-foreground">
          View details for key package {id.slice(0, 16)}...
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-muted-foreground/60 mb-1 text-xs">
              Event ID
            </Label>
            <div className="font-mono text-xs text-muted-foreground break-all">
              {event.id}
            </div>
          </div>

          <div>
            <Label className="text-muted-foreground/60 mb-1 text-xs">
              Created
            </Label>
            <div className="text-sm">{timeAgo}</div>
          </div>

          <div>
            <Label className="text-muted-foreground/60 mb-1 text-xs">
              Client
            </Label>
            <div>
              <Badge variant="outline">{client?.name || "Unknown"}</Badge>
            </div>
          </div>

          <div>
            <Label className="text-muted-foreground/60 mb-1 text-xs">
              Cipher Suite
            </Label>
            <div>
              {cipherSuiteId !== undefined ? (
                <CipherSuiteBadge cipherSuite={cipherSuiteId} />
              ) : (
                <Badge variant="destructive" className="outline">
                  Unknown
                </Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Key Package Data</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="bg-muted p-4 rounded-lg overflow-auto">
            <KeyPackageDataView keyPackage={keyPackage} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
