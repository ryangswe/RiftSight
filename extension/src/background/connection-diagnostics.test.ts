import { describe, expect, it } from "vitest";
import { STATUS_CHECK_ATTEMPT_THRESHOLD, credentialNeedsReconnect, shouldCheckCredentialStatus } from "./connection-diagnostics.js";
import type { ProducerCredentialStatusResult } from "./auth.js";

describe("shouldCheckCredentialStatus", () => {
  it("is false below the threshold — a single isolated failure never triggers a check", () => {
    expect(shouldCheckCredentialStatus(1, false)).toBe(false);
  });

  it("is true exactly at the threshold, when not already checked this streak", () => {
    expect(shouldCheckCredentialStatus(STATUS_CHECK_ATTEMPT_THRESHOLD, false)).toBe(true);
  });

  it("is false past the threshold once already checked — never re-checks every subsequent failure in the same streak", () => {
    expect(shouldCheckCredentialStatus(STATUS_CHECK_ATTEMPT_THRESHOLD, true)).toBe(false);
    expect(shouldCheckCredentialStatus(STATUS_CHECK_ATTEMPT_THRESHOLD + 5, true)).toBe(false);
  });

  it("is false past the threshold if somehow not yet marked checked (still only fires exactly at the threshold)", () => {
    expect(shouldCheckCredentialStatus(STATUS_CHECK_ATTEMPT_THRESHOLD + 1, false)).toBe(false);
  });
});

describe("credentialNeedsReconnect", () => {
  it("is false for a confirmed-valid credential — the failures were something else", () => {
    expect(credentialNeedsReconnect({ status: "valid" })).toBe(false);
  });

  it("is false for a network error — never treated as a credential problem", () => {
    expect(credentialNeedsReconnect({ status: "network-error" })).toBe(false);
  });

  it("is true for every genuine credential-problem outcome", () => {
    const badOutcomes: ProducerCredentialStatusResult[] = [
      { status: "invalid_or_malformed" },
      { status: "revoked_or_replaced" },
      { status: "not_allowlisted" },
    ];
    for (const outcome of badOutcomes) {
      expect(credentialNeedsReconnect(outcome)).toBe(true);
    }
  });
});
