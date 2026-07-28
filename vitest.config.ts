import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "protocol/src/**/*.test.ts",
      "relay/src/**/*.test.ts",
      "debug-viewer/src/**/*.test.ts",
      "extension/src/**/*.test.ts",
    ],
  },
});
