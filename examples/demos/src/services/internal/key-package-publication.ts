import {
  MarmotClient,
  type ListedKeyPackage,
  type Unsubscribable,
} from "@internet-privacy/marmot-ts/client";
import { BehaviorSubject } from "rxjs";
import { bytesToHex as hex } from "applesauce-core/helpers/event";

export type SessionKeyState = {
  busy: boolean;
  enabled: boolean;
  current?: ListedKeyPackage;
  error?: string;
};

/** The sidebar and every demo share the same account's private key packages. */
export class KeyPackagePublication {
  readonly state$ = new BehaviorSubject<SessionKeyState>({
    busy: false,
    enabled: false,
  });
  #tail: Promise<unknown> = Promise.resolve();
  #inbox?: Unsubscribable;
  #retirement?: ReturnType<typeof setTimeout>;
  readonly #controller = new AbortController();
  readonly clientId: string;

  constructor(
    readonly client: MarmotClient,
    readonly relays: string[],
    readonly pubkey: string,
  ) {
    const clientId = client.keyPackages.clientId;
    if (!clientId)
      throw new Error("The demo client requires a key-package slot");
    this.clientId = clientId;
    client.invites.on("error", this.#error);
  }

  get signal() {
    return this.#controller.signal;
  }

  #error = (cause: unknown) => {
    if (!this.signal.aborted)
      this.state$.next({
        ...this.state$.value,
        error: cause instanceof Error ? cause.message : String(cause),
      });
  };

  async start(autoPublish: boolean) {
    try {
      const packages = await this.#packages();
      this.signal.throwIfAborted();
      const current = packages[0];
      this.state$.next({ busy: false, enabled: !!current, current });
      if (autoPublish) await this.publish();
      else if (current) {
        await this.#listen();
        await this.#retireSuperseded();
      }
    } catch (cause) {
      this.#error(cause);
      throw cause;
    }
  }

  /** Publish or replace a package only when explicitly requested. */
  publish = () => this.#run(false);
  rotate = () => this.#run(true);

  async #packages() {
    return (await this.client.keyPackages.list())
      .filter(
        (pkg) => pkg.identifier === this.clientId && pkg.published?.length,
      )
      .sort(
        (a, b) =>
          Math.max(...b.published!.map((event) => event.created_at)) -
          Math.max(...a.published!.map((event) => event.created_at)),
      );
  }

  #run(rotate: boolean): Promise<void> {
    const task = this.#tail.then(async () => {
      this.signal.throwIfAborted();
      this.state$.next({ ...this.state$.value, busy: true, error: undefined });
      try {
        this.signal.throwIfAborted();
        const packages = await this.#packages();
        const current = packages[0];
        if (current?.published?.length) {
          // A new addressable publication must be later than the old one.
          const latest = Math.max(
            ...current.published.map((event) => event.created_at),
          );
          const delay = (latest + 1) * 1000 - Date.now();
          if (delay > 0)
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(timer);
                reject(this.signal.reason);
              };
              const timer = setTimeout(() => {
                this.signal.removeEventListener("abort", abort);
                resolve();
              }, delay);
              this.signal.addEventListener("abort", abort, { once: true });
            });
        }
        this.signal.throwIfAborted();
        const lifetime = current?.publicPackage.leafNode.lifetime;
        const now = BigInt(Math.floor(Date.now() / 1000));
        const reusable =
          !rotate &&
          current &&
          !current.used &&
          !current.nonCurrent &&
          lifetime &&
          lifetime.notBefore <= now &&
          lifetime.notAfter >= now &&
          (await this.client.keyPackages.getPrivateKey(current.keyPackageRef));
        // Same slot, fresh keys; keep old init keys for pending Welcomes.
        const pkg = reusable
          ? current
          : await this.client.keyPackages.create({
              relays: this.relays,
            });
        this.signal.throwIfAborted();
        const stored = await this.client.keyPackages.get(
          hex(pkg.keyPackageRef),
        );
        if (!stored?.published?.length)
          throw new Error("Key package was not published");
        // Re-send the signed publication when the local worker was restarted.
        for (const event of stored.published) {
          const responses = await this.client.network.publish(
            this.relays,
            event,
          );
          if (!Object.values(responses).some((response) => response.ok))
            throw new Error(
              "Key-package publication was rejected by every relay",
            );
        }
        this.signal.throwIfAborted();
        this.state$.next({
          busy: false,
          enabled: true,
          current: { ...pkg, published: stored.published },
        });
        await this.#retireSuperseded();
        await this.#listen();
      } catch (cause) {
        if (!this.signal.aborted)
          this.state$.next({
            ...this.state$.value,
            busy: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        throw cause;
      }
    });
    this.#tail = task.catch(() => {});
    return task;
  }

  async #listen() {
    if (this.#inbox) return;
    const relays = await this.client.network.getUserInboxRelays(this.pubkey);
    this.signal.throwIfAborted();
    const inbox = await this.client.invites.listen(relays);
    if (this.signal.aborted) inbox.unsubscribe();
    else this.#inbox = inbox;
  }

  async #retireSuperseded() {
    this.signal.throwIfAborted();
    clearTimeout(this.#retirement);
    const packages = (await this.#packages()).reverse();
    let next = Infinity;
    for (let index = 0; index < packages.length - 1; index++) {
      const pkg = packages[index];
      this.signal.throwIfAborted();
      const lifetime = pkg.publicPackage.leafNode.lifetime;
      const deadline = Math.min(
        Number(lifetime?.notAfter ?? 0n) * 1000,
        (packages[index + 1].published![0].created_at + 86_400) * 1000,
      );
      if (deadline <= Date.now())
        await this.client.keyPackages.remove(pkg.keyPackageRef);
      else next = Math.min(next, deadline);
    }
    if (Number.isFinite(next) && !this.signal.aborted)
      this.#retirement = setTimeout(
        () => {
          void this.#retireSuperseded().catch(this.#error);
        },
        Math.max(0, next - Date.now()),
      );
  }

  close() {
    if (this.signal.aborted) return;
    this.#controller.abort();
    clearTimeout(this.#retirement);
    this.#inbox?.unsubscribe();
    this.client.invites.off("error", this.#error);
    this.state$.complete();
  }
}
