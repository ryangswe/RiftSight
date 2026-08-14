import { describe, expect, it } from "vitest";
import { parseYouTubeChannelInput } from "./youtube-channel-input.js";

const CHANNEL = "UC" + "a1B2c3D4e5F6g7H8i9J0kL";

describe("parseYouTubeChannelInput", () => {
  it("accepts a bare canonical id, with surrounding whitespace", () => {
    expect(parseYouTubeChannelInput(CHANNEL)).toBe(CHANNEL);
    expect(parseYouTubeChannelInput(`  ${CHANNEL}\n`)).toBe(CHANNEL);
  });

  it("extracts the id from /channel/ URLs, with and without scheme, path tails, and query strings", () => {
    expect(parseYouTubeChannelInput(`https://www.youtube.com/channel/${CHANNEL}`)).toBe(CHANNEL);
    expect(parseYouTubeChannelInput(`www.youtube.com/channel/${CHANNEL}/videos`)).toBe(CHANNEL);
    expect(parseYouTubeChannelInput(`https://youtube.com/channel/${CHANNEL}?view=0`)).toBe(CHANNEL);
  });

  it("rejects handles, custom URLs, watch URLs, and near-miss ids", () => {
    expect(parseYouTubeChannelInput("@somehandle")).toBeNull();
    expect(parseYouTubeChannelInput("https://www.youtube.com/@somehandle")).toBeNull();
    expect(parseYouTubeChannelInput("https://www.youtube.com/watch?v=abc123")).toBeNull();
    expect(parseYouTubeChannelInput("UCshort")).toBeNull();
    expect(parseYouTubeChannelInput(CHANNEL + "x")).toBeNull();
    expect(parseYouTubeChannelInput("")).toBeNull();
    expect(parseYouTubeChannelInput("   ")).toBeNull();
  });
});
