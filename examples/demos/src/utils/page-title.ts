import type { IAccount } from "applesauce-accounts";
import { getDevelopmentName } from "./development-name.js";
import { short } from "./format.js";

export function getPageTitle(pathname: string, account?: IAccount): string {
  if (pathname.replace(/\/$/, "") === "/relay")
    return "Relay inspector · marmot-ts demos";
  return account
    ? `${getDevelopmentName(account) || short(account.pubkey)} · marmot-ts demos`
    : "marmot-ts demos";
}
