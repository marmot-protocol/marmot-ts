import { Rumor } from "applesauce-common/helpers";
import { GroupHistoryStore } from "../client/index.js";
import { deserializeApplicationRumor } from "../core/group-message.js";
import { EventEmitter } from "eventemitter3";

export interface GroupHistoryStoreFilter {
	/** rumor created_at > since (inclusive) */
	since?: number;
	/** limit the number of rumors to return */
	limit?: number;
	/** rumor created_at < until (exclusive) */
	until?: number;
}
export interface MarmotGroupHistoryStoreBackend {
	/** Load rumor events from a specific time in history. Results are ordered by created_at descending (newest first). */
	getRumors(
		groupId: Uint8Array,
		filter: GroupHistoryStoreFilter,
	): Promise<Rumor[]>;
	/** Save a new group rumor event */
	addRumor(groupId: Uint8Array, message: Rumor): Promise<void>;
}

type MarmotGroupHistoryStoreEvents = {
	"rumor": (rumor: Rumor) => void;
};

/** A {@link GroupHistoryStore} implementation that parses and stores the MIP-03 rumors for a group */
export class MarmotGroupHistoryStore
	extends EventEmitter<MarmotGroupHistoryStoreEvents>
	implements GroupHistoryStore {
	constructor(
		private groupId: Uint8Array,
		private backend: MarmotGroupHistoryStoreBackend,
	) {
		super();
	}

	/** Creates a new method that will create group history store instances for a group id */
	static makeGroupHistoryInterface(
		backend: MarmotGroupHistoryStoreBackend,
	): (groupId: Uint8Array) => MarmotGroupHistoryStore {
		return (groupId: Uint8Array) =>
			new MarmotGroupHistoryStore(groupId, backend);
	}

	/** Parses an MLS message and saves it as a MIP-03 rumor */
	async saveMessage(message: Uint8Array): Promise<void> {
		try {
			const rumor = deserializeApplicationRumor(message);
			await this.saveRumor(rumor);
		} catch (error) {
			// Failed to read rumor, skip saving
		}
	}

	/** Saves a new MIP-03 rumor to the backend */
	async saveRumor(rumor: Rumor): Promise<void> {
		await this.backend.addRumor(this.groupId, rumor);

		// Notify listeners that a new rumor has been added
		this.emit("rumor", rumor);
	}

	/**
	 * Async generator for paginated loading of historical group messages.
	 *
	 * This method allows UI components to create a generator and load historical
	 * messages in pages, enabling infinite scroll or paginated UI patterns.
	 *
	 * @param groupId - The group ID to load messages for
	 * @param limit - Number of messages per page
	 * @param until - Optional starting timestamp (Unix seconds) (inclusive). If not provided,
	 *                starts from the most recent messages. Messages are loaded
	 *                going backwards in time from this point.
	 * @yields Batches of Rumor events, with each batch containing up to `limit` messages
	 *
	 * @example
	 * ```ts
	 * const generator = historyStore.createPaginatedLoader(groupId, 50);
	 * for await (const page of generator) {
	 *   // Process page of messages
	 *   console.log(`Loaded ${page.length} messages`);
	 * }
	 * ```
	 */
	async *createPaginatedLoader(
		limit: number,
		until?: number,
	): AsyncGenerator<Rumor[], Rumor[]> {
		let cursor = until ?? undefined;

		while (true) {
			const rumors = await this.backend.getRumors(this.groupId, {
				until: cursor,
				limit,
			});

			// If no rumors returned, we've reached the end
			if (rumors.length === 0) {
				return rumors;
			}

			// Find the oldest timestamp in the current page
			// and set it as the new `until` for the next page (going backwards)
			const oldest = Math.min(
				...rumors.map((rumor) => rumor.created_at),
			);

			// Set the next `until` to be just before the oldest message
			// This ensures we get the next older page without duplicates
			if (!cursor || oldest < cursor) cursor = oldest - 1;

			// If we got fewer than the limit, we've reached the end
			if (rumors.length < limit) {
				return rumors;
			} else {
				yield rumors;
			}
		}
	}
}
