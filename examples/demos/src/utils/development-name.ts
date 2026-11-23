import type { IAccount } from "applesauce-accounts";

export function getDevelopmentName(account: IAccount): string | undefined {
  const metadata = account.metadata;
  return metadata &&
    typeof metadata === "object" &&
    "developmentName" in metadata &&
    typeof metadata.developmentName === "string"
    ? metadata.developmentName
    : undefined;
}
