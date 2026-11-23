import {
  memoryDatabase,
  type KeyPackageRow,
  type MarmotDatabase,
} from "@internet-privacy/marmot-ts/client";
import type { TransportMode } from "../mode.js";

type SavedPackage = Omit<KeyPackageRow, "publicPackage" | "privatePackage"> & {
  publicPackage: number[];
  privatePackage?: number[];
};
type SavedSession = { version: 1; packages: SavedPackage[] };

/** Only account key bundles survive reloads; group state stays demo-local. */
export async function sessionDatabase(
  pubkey: string,
  mode: TransportMode,
  clientId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
): Promise<MarmotDatabase> {
  const key = `marmot-demos:mls:${clientId}:${mode}:${pubkey}`;
  const saved = storage.getItem(key);
  const state: SavedSession = saved
    ? JSON.parse(saved)
    : {
        version: 1,
        packages: [],
      };
  if (state.version !== 1 || !Array.isArray(state.packages))
    throw new Error("Invalid session key-package storage");
  const database = memoryDatabase();
  await database.account.transaction(async (tx) => {
    for (const row of state.packages) {
      await tx.keyPackages.put({
        ...row,
        publicPackage: new Uint8Array(row.publicPackage),
        privatePackage:
          row.privatePackage && new Uint8Array(row.privatePackage),
      });
    }
  });
  storage.setItem(key, JSON.stringify(state));
  const transact = database.account.transaction.bind(database.account);
  let closed = false;
  database.account.close = async () => {
    closed = true;
  };
  database.account.transaction = (fn) =>
    transact(async (tx) => {
      if (closed) throw new Error("Session database closed");
      const result = await fn(tx);
      if (closed) throw new Error("Session database closed");
      const packages = (await tx.keyPackages.all()).map(
        (row): SavedPackage => ({
          ...row,
          publicPackage: [...row.publicPackage],
          privatePackage: row.privatePackage && [...row.privatePackage],
        }),
      );
      // Persist before the in-memory transaction commits, so a storage failure
      // cannot leave a published package without its reloadable private bundle.
      storage.setItem(key, JSON.stringify({ ...state, packages }));
      return result;
    });
  return database;
}
