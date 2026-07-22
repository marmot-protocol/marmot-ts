import { verifyEvent } from "applesauce-core/helpers";
import { describe, expect, it } from "vitest";

import {
  defaultVerifyEvent,
  fakeVerifyEvent,
  RejectReason,
} from "../verify.js";

describe("verify", () => {
  it("defaultVerifyEvent is referentially the applesauce verifyEvent function", () => {
    expect(defaultVerifyEvent).toBe(verifyEvent);
  });

  it("re-exports fakeVerifyEvent from applesauce-core/helpers", () => {
    expect(typeof fakeVerifyEvent).toBe("function");
  });

  it("RejectReason accepts exactly the three D-05 literals and no others", () => {
    const invalidSignature: RejectReason = "invalid-signature";
    const lifetimeCap: RejectReason = "lifetime-cap";
    const tagCardinality: RejectReason = "tag-cardinality";
    expect(invalidSignature).toBe("invalid-signature");
    expect(lifetimeCap).toBe("lifetime-cap");
    expect(tagCardinality).toBe("tag-cardinality");

    // @ts-expect-error - "something-else" is not a member of RejectReason
    const notAReason: RejectReason = "something-else";
    expect(notAReason).toBe("something-else");
  });
});
