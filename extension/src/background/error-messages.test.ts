import { describe, expect, it } from "vitest";
import { describeStreamerError, STREAMER_ERROR_MESSAGE, type StreamerErrorCode } from "./error-messages.js";

describe("describeStreamerError", () => {
  it("returns a non-empty, human-readable message for every defined code", () => {
    const codes = Object.keys(STREAMER_ERROR_MESSAGE) as StreamerErrorCode[];
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const message = describeStreamerError(code);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("never mentions technical/internal terms a streamer wouldn't recognize", () => {
    const forbidden = ["websocket", "jwt", "credential hash", "sql", "stack trace", "undefined", "null"];
    for (const message of Object.values(STREAMER_ERROR_MESSAGE)) {
      const lower = message.toLowerCase();
      for (const term of forbidden) {
        expect(lower).not.toContain(term);
      }
    }
  });
});
