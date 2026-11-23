import { describe, expect, it } from "vitest";
import { MemoryGroupDatabases } from "../../storage/database/memory.js";
import { SessionDatabase } from "../session-database.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("cryptographic session database capability", () => {
  it("rolls back an admitted transaction before the replacement can commit", async () => {
    const db = await new MemoryGroupDatabases().open("group");
    const owner = new SessionDatabase(db);
    const entered = deferred();
    const release = deferred();
    const writing = owner.database.transaction(async (tx) => {
      await tx.updateGroup({ removed: true });
      entered.resolve();
      await release.promise;
    });
    const failed = expect(writing).rejects.toThrow("replacement");
    await entered.promise;
    const paused = owner.pause();
    release.resolve();
    await paused;
    await failed;
    expect(await db.group()).toEqual({});
    await db.transaction((tx) => tx.updateGroup({ removed: false }));
    owner.revoke();
    expect(() =>
      owner.database.transaction((tx) => tx.updateGroup({ removed: true })),
    ).toThrow("replacement");
    expect((await db.group()).removed).toBe(false);
  });

  it("waits for history cache writes and restores admission after abort", async () => {
    const db = await new MemoryGroupDatabases().open("group");
    const owner = new SessionDatabase(db);
    const release = deferred();
    const writing = owner.run(() => release.promise);
    let paused = false;
    const pausing = owner.pause().then(() => (paused = true));
    await Promise.resolve();
    expect(paused).toBe(false);
    release.resolve();
    await writing;
    await pausing;
    owner.resume();
    await owner.database.transaction((tx) => tx.updateGroup({ removed: true }));
    expect((await db.group()).removed).toBe(true);
  });

  it("moves a staged owner's reads and writes to the installed database", async () => {
    const dbs = new MemoryGroupDatabases();
    const staged = await dbs.open("staged");
    const installed = await dbs.open("installed");
    const owner = new SessionDatabase(staged);
    await owner.database.transaction((tx) => tx.updateGroup({ removed: true }));
    owner.activate(installed);
    expect(await owner.database.group()).toEqual({});
    await owner.database.transaction((tx) =>
      tx.updateGroup({ removed: false }),
    );
    expect((await installed.group()).removed).toBe(false);
    expect((await staged.group()).removed).toBe(true);
  });
});
