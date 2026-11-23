import type {
  GroupTransaction,
  MarmotGroupDatabase,
} from "../storage/database/types.js";

/**
 * A database capability owned by exactly one cryptographic session. Revoking
 * it fences even writes already queued in the adapter, not just new callers.
 */
export class SessionDatabase {
  #target: MarmotGroupDatabase;
  #paused = false;
  #revoked = false;
  readonly #writes = new Set<Promise<unknown>>();
  readonly database: MarmotGroupDatabase;

  constructor(target: MarmotGroupDatabase) {
    this.#target = target;
    const table = <K extends keyof MarmotGroupDatabase>(key: K) =>
      new Proxy({} as MarmotGroupDatabase[K] & object, {
        get: (_object, method) => {
          const source = this.#target[key] as object;
          const value = Reflect.get(source, method);
          return typeof value === "function" ? value.bind(source) : value;
        },
      });
    this.database = {
      group: () => this.#target.group(),
      treeNodes: table("treeNodes"),
      wrappers: table("wrappers"),
      effects: table("effects"),
      backfill: table("backfill"),
      messages: table("messages"),
      deliveries: table("deliveries"),
      transaction: <T>(operation: (tx: GroupTransaction) => Promise<T>) => {
        this.assertOpen();
        const write = this.#target.transaction(async (tx) => {
          this.assertOpen();
          const result = await operation(tx);
          // A pause during an admitted transaction rolls the whole thing back.
          this.assertOpen();
          return result;
        });
        this.#writes.add(write);
        void write.finally(() => this.#writes.delete(write)).catch(() => {});
        return write;
      },
      // The facade, not a retired session, owns the actual connection.
      close: async () => {},
    };
  }

  assertOpen(): void {
    if (this.#paused || this.#revoked)
      throw new Error("Group session replacement in progress or completed");
  }

  /** Include history-store writes that use the facade's shared rumor cache. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const write = operation();
    this.#writes.add(write);
    try {
      return await write;
    } finally {
      this.#writes.delete(write);
    }
  }

  async pause(): Promise<void> {
    this.#paused = true;
    await Promise.allSettled([...this.#writes]);
  }

  resume(): void {
    if (!this.#revoked) this.#paused = false;
  }

  revoke(): void {
    this.#revoked = true;
  }

  /** Switch a fully staged session to the atomically installed database. */
  activate(target: MarmotGroupDatabase): void {
    this.#target = target;
  }
}
