/** An error that is thrown when a group has no relays available to send messages. */
export class NoGroupRelaysError extends Error {
  constructor() {
    super("Group has no relays available to send messages.");
  }
}

/** An error that is thrown the client is unable to find the MarmotGroupData in the ClientState of a group. */
export class NoMarmotGroupDataError extends Error {
  constructor() {
    super("MarmotGroupData not found in ClientState.");
  }
}

/** An error that is thrown if no relay received an event. */
export class NoRelayReceivedEventError extends Error {
  constructor(eventId: string) {
    super(`No relay received event ${eventId}`);
  }
}
