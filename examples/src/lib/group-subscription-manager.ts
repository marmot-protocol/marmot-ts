import { Subscription } from "rxjs";
import { NostrEvent } from "applesauce-core/helpers/event";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MarmotClient } from "../../../src";
import { MarmotGroup } from "../../../src/client/group/marmot-group";
import { GROUP_EVENT_KIND } from "../../../src";
import { pool } from "./nostr";
import { deserializeApplicationRumor } from "../../../src";
import { Rumor } from "applesauce-common/helpers/gift-wrap";

/**
 * Manages persistent subscriptions for all groups in the store.
 * Ensures that commits and other group events are received and processed
 * even when the user is not actively viewing a specific group.
 */
export class GroupSubscriptionManager {
  private groupSubscriptions = new Map<
    string,
    {
      subscription: Subscription;
      seenEventIds: Set<string>;
    }
  >();

  private client: MarmotClient;
  private isActive = false;
  private applicationMessageCallbacks = new Map<
    string,
    (messages: Rumor[]) => void
  >();

  constructor(client: MarmotClient) {
    this.client = client;
  }

  /**
   * Register a callback to receive application messages for a specific group.
   * This allows UI components to receive chat messages without creating duplicate subscriptions.
   */
  onApplicationMessage(
    groupIdHex: string,
    callback: (messages: Rumor[]) => void,
  ): () => void {
    this.applicationMessageCallbacks.set(groupIdHex, callback);
    // Return unsubscribe function
    return () => {
      this.applicationMessageCallbacks.delete(groupIdHex);
    };
  }

  /**
   * Start managing subscriptions for all groups in the store.
   * This should be called when a user logs in.
   */
  async start(): Promise<void> {
    if (this.isActive) return;

    this.isActive = true;
    await this.reconcileSubscriptions();
  }

  /**
   * Stop all subscriptions and clean up resources.
   * This should be called when a user logs out.
   */
  stop(): void {
    this.isActive = false;

    // Unsubscribe from all group subscriptions
    for (const [groupId, sub] of this.groupSubscriptions) {
      sub.subscription.unsubscribe();
      this.groupSubscriptions.delete(groupId);
    }
  }

  /**
   * Reconcile subscriptions with the current state of the group store.
   * Adds subscriptions for new groups and removes subscriptions for deleted groups.
   */
  async reconcileSubscriptions(): Promise<void> {
    if (!this.isActive) return;

    try {
      // Get all groups from the store
      const groups = await this.client.groupStateStore.list();
      const groupIds = new Set<string>();

      // Ensure we have subscriptions for all groups
      for (const groupId of groups) {
        const groupIdHex = bytesToHex(groupId);
        groupIds.add(groupIdHex);

        if (!this.groupSubscriptions.has(groupIdHex)) {
          await this.subscribeToGroup(groupIdHex);
        }
      }

      // Remove subscriptions for groups that no longer exist
      for (const [groupId] of this.groupSubscriptions) {
        if (!groupIds.has(groupId)) {
          this.unsubscribeFromGroup(groupId);
        }
      }
    } catch (error) {
      console.error("Failed to reconcile group subscriptions:", error);
    }
  }

  /**
   * Subscribe to events for a specific group.
   */
  private async subscribeToGroup(groupIdHex: string): Promise<void> {
    try {
      // Load the group to get its relays and data
      const group = await this.client.getGroup(groupIdHex);
      const relays = group.relays;

      if (!relays || relays.length === 0) {
        console.warn(`No relays configured for group ${groupIdHex}`);
        return;
      }

      // Create subscription filter
      const filters = {
        kinds: [GROUP_EVENT_KIND],
        "#h": [groupIdHex],
      };

      // Set up subscription using the pool
      const observable = pool.subscription(relays, filters);
      const seenEventIds = new Set<string>();

      const subscription = observable.subscribe({
        next: async (value) => {
          // Handle both single events and arrays
          if (value === "EOSE") return;
          const events: NostrEvent[] = Array.isArray(value) ? value : [value];

          // Process events immediately as they arrive
          await this.processEvents(groupIdHex, group, events, seenEventIds);
        },
        error: (err) => {
          console.error(`Subscription error for group ${groupIdHex}:`, err);
        },
        complete: () => {
          console.debug(`Subscription completed for group ${groupIdHex}`);
        },
      });

      // Store the subscription
      this.groupSubscriptions.set(groupIdHex, {
        subscription,
        seenEventIds,
      });

      console.log(
        `[GroupSubscriptionManager] Started subscription for group ${groupIdHex} on relays:`,
        relays,
      );

      // Also do an initial fetch to catch up on missed events
      await this.fetchHistoricalEvents(group, seenEventIds);
    } catch (error) {
      console.error(`Failed to subscribe to group ${groupIdHex}:`, error);
    }
  }

  /**
   * Unsubscribe from a group's events.
   */
  private unsubscribeFromGroup(groupIdHex: string): void {
    const sub = this.groupSubscriptions.get(groupIdHex);
    if (sub) {
      sub.subscription.unsubscribe();
      this.groupSubscriptions.delete(groupIdHex);
      console.log(
        `[GroupSubscriptionManager] Stopped subscription for group ${groupIdHex}`,
      );
    }
  }

  /**
   * Process incoming events for a group.
   */
  private async processEvents(
    groupIdHex: string,
    group: MarmotGroup,
    events: NostrEvent[],
    seenEventIds: Set<string>,
  ): Promise<void> {
    if (events.length === 0) return;

    // Deduplicate events before processing
    const newEvents = events.filter((e) => !seenEventIds.has(e.id));
    if (newEvents.length === 0) return;

    // Add new event IDs to seen set
    newEvents.forEach((e) => seenEventIds.add(e.id));

    try {
      // Process events through the group's ingest function
      // This handles commits, proposals, and application messages
      const newMessages: Rumor[] = [];
      for await (const result of group.ingest(newEvents)) {
        // We don't need to do anything special here - the ingest function
        // already updates the group state and persists it via group.save()

        // Log commit processing for debugging
        if (result.kind === "newState") {
          console.log(
            `Processed commit for group ${groupIdHex}, new epoch: ${group.state.groupContext.epoch}`,
          );
        }

        // Collect application messages for UI
        if (result.kind === "applicationMessage") {
          try {
            const applicationData = result.message;
            const rumor = deserializeApplicationRumor(applicationData);
            newMessages.push(rumor);
          } catch (parseErr) {
            console.error("Failed to parse application message:", parseErr);
          }
        }
      }

      // Notify registered callbacks about new application messages
      if (newMessages.length > 0) {
        const callback = this.applicationMessageCallbacks.get(groupIdHex);
        if (callback) {
          callback(newMessages);
        }
      }
    } catch (err) {
      console.error(`Failed to process events for group ${groupIdHex}:`, err);
    }
  }

  /**
   * Fetch historical events for a group to catch up on missed commits.
   */
  private async fetchHistoricalEvents(
    group: MarmotGroup,
    seenEventIds: Set<string>,
  ): Promise<void> {
    try {
      const relays = group.relays;
      if (!relays || relays.length === 0) return;

      const groupIdHex = bytesToHex(group.state.groupContext.groupId);

      // Request existing events from relays
      const filters = {
        kinds: [GROUP_EVENT_KIND],
        "#h": [groupIdHex],
      };

      // Use the network interface to make a request
      const events = await this.client.network.request(relays, filters);

      if (events.length > 0) {
        console.log(
          `[GroupSubscriptionManager] Fetched ${events.length} historical events for group ${groupIdHex}`,
        );
        await this.processEvents(groupIdHex, group, events, seenEventIds);
      }
    } catch (error) {
      console.error(`Failed to fetch historical events:`, error);
    }
  }

  /**
   * Get the current subscription status for all groups.
   */
  getSubscriptionStatus(): Map<string, boolean> {
    const status = new Map<string, boolean>();
    for (const [groupId, sub] of this.groupSubscriptions) {
      status.set(groupId, !sub.subscription.closed);
    }
    return status;
  }
}
