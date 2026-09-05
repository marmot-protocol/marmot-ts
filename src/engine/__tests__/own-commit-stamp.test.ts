import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  decodeOwnCommitRecord,
  encodeOwnCommitRecord,
  ownCommitRecordIdentity,
  type OwnCommitConvergenceStamp,
} from "../own-commit-stamp.js";

const WIRE = Uint8Array.of(0xaa, 0xbb, 0xcc);
const STAMP: OwnCommitConvergenceStamp = {
  committer: "02".repeat(32),
  priority: "privileged",
  consumedProposalRefs: [Uint8Array.of(0x20), Uint8Array.of(0x01)],
};

describe("own commit convergence stamp", () => {
  it("round-trips wire bytes and canonicalizes proposal references", () => {
    const encoded = encodeOwnCommitRecord({ wireBytes: WIRE, stamp: STAMP });
    const decoded = decodeOwnCommitRecord(encoded);

    expect(decoded.kind).toBe("stamped");
    if (decoded.kind !== "stamped") throw new Error("expected stamped record");
    expect(decoded.wireBytes).toEqual(WIRE);
    expect(decoded.stamp).toEqual({
      ...STAMP,
      consumedProposalRefs: [Uint8Array.of(0x01), Uint8Array.of(0x20)],
    });
    expect(
      encodeOwnCommitRecord({
        wireBytes: WIRE,
        stamp: { ...STAMP, consumedProposalRefs: [...STAMP.consumedProposalRefs].reverse() },
      }),
    ).toEqual(encoded);
  });

  it("distinguishes legacy wire records without inferring evidence", () => {
    expect(decodeOwnCommitRecord(WIRE)).toEqual({
      kind: "legacy",
      wireBytes: WIRE,
    });
  });

  it("fails closed for corrupt, unknown-version, and trailing stamped bytes", () => {
    const encoded = encodeOwnCommitRecord({ wireBytes: WIRE, stamp: STAMP });
    expect(() => decodeOwnCommitRecord(encoded.slice(0, -1))).toThrow();
    const unknownVersion = encoded.slice();
    unknownVersion[4] = 0xff;
    expect(() => decodeOwnCommitRecord(unknownVersion)).toThrow(/version/i);
    expect(() =>
      decodeOwnCommitRecord(new Uint8Array([...encoded, 0x00])),
    ).toThrow(/end|trailing/i);
  });

  it("keeps record identity tied only to the exact commit wire bytes", () => {
    const stamped = decodeOwnCommitRecord(
      encodeOwnCommitRecord({ wireBytes: WIRE, stamp: STAMP }),
    );
    const legacy = decodeOwnCommitRecord(WIRE);

    expect(bytesToHex(ownCommitRecordIdentity(stamped))).toBe(
      bytesToHex(ownCommitRecordIdentity(legacy)),
    );
  });
});
