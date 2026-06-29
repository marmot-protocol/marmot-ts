/** @module @category Extra - Audit */
import type { AuditLogWriter } from "../../audit/index.js";

export type IndexedDbAuditWriterOptions = {
  databaseName?: string;
  storeName?: string;
  logId: string;
};

export class IndexedDbAuditWriter implements AuditLogWriter {
  readonly databaseName: string;
  readonly storeName: string;
  readonly logId: string;
  #db: Promise<IDBDatabase>;
  #index = 0;

  constructor(options: IndexedDbAuditWriterOptions) {
    this.databaseName = options.databaseName ?? "marmot-audit-logs";
    this.storeName = options.storeName ?? "lines";
    this.logId = options.logId;
    this.#db = openAuditDatabase(this.databaseName, this.storeName);
  }

  async appendLine(line: string): Promise<void> {
    const db = await this.#db;
    await idbRequest<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.put(
        { logId: this.logId, index: this.#index++, line },
        `${this.logId}:${this.#index}`,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () =>
        reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    const db = await this.#db;
    db.close();
  }
}

export type OpfsAuditWriterOptions = {
  directory?: string;
  fileName: string;
};

export class OpfsAuditWriter implements AuditLogWriter {
  readonly directory: string | undefined;
  readonly fileName: string;
  #file: Promise<FileSystemFileHandle>;

  constructor(options: OpfsAuditWriterOptions) {
    this.directory = options.directory;
    this.fileName = options.fileName;
    this.#file = openOpfsFile(options);
  }

  async appendLine(line: string): Promise<void> {
    const file = await this.#file;
    const existing = await file.getFile();
    const writable = await file.createWritable({ keepExistingData: true });
    await writable.seek(existing.size);
    await writable.write(line);
    await writable.close();
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export type AutoBrowserAuditWriterOptions =
  | ({ backend?: "auto" | "opfs" } & OpfsAuditWriterOptions)
  | ({ backend: "indexeddb" } & IndexedDbAuditWriterOptions);

export class AutoBrowserAuditWriter implements AuditLogWriter {
  readonly writer: AuditLogWriter;

  private constructor(writer: AuditLogWriter) {
    this.writer = writer;
  }

  static async open(
    options: AutoBrowserAuditWriterOptions,
  ): Promise<AutoBrowserAuditWriter> {
    if (options.backend === "indexeddb")
      return new AutoBrowserAuditWriter(new IndexedDbAuditWriter(options));
    if (options.backend === "opfs" || supportsOpfs())
      return new AutoBrowserAuditWriter(new OpfsAuditWriter(options));
    return new AutoBrowserAuditWriter(
      new IndexedDbAuditWriter({ logId: options.fileName }),
    );
  }

  appendLine(line: string): void | Promise<void> {
    return this.writer.appendLine(line);
  }

  flush(): void | Promise<void> {
    return this.writer.flush?.();
  }

  close(): void | Promise<void> {
    return this.writer.close?.();
  }
}

function openAuditDatabase(
  databaseName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return idbRequest((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName))
        db.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function idbRequest<T>(
  run: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => run(resolve, reject));
}

async function openOpfsFile(
  options: OpfsAuditWriterOptions,
): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  const directory = options.directory
    ? await root.getDirectoryHandle(options.directory, { create: true })
    : root;
  return directory.getFileHandle(options.fileName, { create: true });
}

function supportsOpfs(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}
