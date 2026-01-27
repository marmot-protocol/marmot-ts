import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { bytesToHex } from "applesauce-core/helpers";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type {
	GroupHistoryStoreFilter,
	MarmotGroupHistoryStoreBackend,
} from "marmot-ts/store";

const DB_VERSION = 1;
const STORE_NAME = "rumors";
const INDEX_NAME = "by_group_created_at";

interface StoredRumor {
	groupId: string;
	created_at: number;
	id: string;
	rumor: Rumor;
}

interface GroupHistoryDB extends DBSchema {
	[STORE_NAME]: {
		value: StoredRumor;
		key: [string, string];
		indexes: { [INDEX_NAME]: [string, number] };
	};
}

/**
 * IndexedDB-backed implementation of {@link MarmotGroupHistoryStoreBackend}.
 * Stores and retrieves group history (MIP-03 rumors) using the `idb` package.
 */
export class IdbGroupHistoryStore implements MarmotGroupHistoryStoreBackend {
	private name: string;

	private dbPromise: Promise<IDBPDatabase<GroupHistoryDB>> | null = null;
	private async getDB(): Promise<IDBPDatabase<GroupHistoryDB>> {
		if (!this.dbPromise) {
			this.dbPromise = openDB<GroupHistoryDB>(this.name, DB_VERSION, {
				upgrade(db) {
					const store = db.createObjectStore(STORE_NAME, {
						keyPath: ["groupId", "id"],
					});
					store.createIndex(INDEX_NAME, ["groupId", "created_at"]);
				},
			});
		}
		return this.dbPromise;
	}

	constructor(name: string) {
		this.name = name;
	}

	async getRumors(
		groupId: Uint8Array,
		filter: GroupHistoryStoreFilter,
	): Promise<Rumor[]> {
		const db = await this.getDB();
		const groupKey = bytesToHex(groupId);
		const { since, until, limit } = filter;

		let range: IDBKeyRange;
		if (since !== undefined && until !== undefined) {
			range = IDBKeyRange.bound(
				[groupKey, since],
				[groupKey, until],
				false,
				false,
			);
		} else if (since !== undefined) {
			range = IDBKeyRange.lowerBound([groupKey, since], false);
		} else if (until !== undefined) {
			range = IDBKeyRange.upperBound([groupKey, until], false);
		} else {
			range = IDBKeyRange.lowerBound([groupKey, 0]);
		}

		const tx = db.transaction(STORE_NAME, "readonly");
		const index = tx.objectStore(STORE_NAME).index(INDEX_NAME);
		const cursor = await index.openCursor(range, "prev");
		const stored: StoredRumor[] = [];
		let cur = cursor;
		while (cur && (limit === undefined || stored.length < limit)) {
			stored.push(cur.value as StoredRumor);
			cur = await cur.continue();
		}
		return stored.map((s) => s.rumor);
	}

	async addRumor(groupId: Uint8Array, message: Rumor): Promise<void> {
		const db = await this.getDB();
		const groupKey = bytesToHex(groupId);
		const entry: StoredRumor = {
			groupId: groupKey,
			created_at: message.created_at,
			id: message.id,
			rumor: message,
		};
		await db.put(STORE_NAME, entry);
	}
}
