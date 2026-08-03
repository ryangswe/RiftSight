// This repo's first chrome.*-touching test — every other chrome.*-touching
// module here (auth.ts, background.ts, presence-tracker.ts) is left as
// untested thin glue by established convention, but the milestone that
// introduced publishingIntent persistence explicitly required tests
// covering "browser-storage restore" and "worker restart" against real
// persistence code, not just the pure decision logic in
// publishing-lifecycle.test.ts. A minimal hand-rolled in-memory fake (no
// new npm dependency) plus vi.resetModules() + a fresh dynamic import
// between assertions is enough: resetModules() clears currentIntent back
// to its initial false, exactly mirroring what a real service-worker
// restart does to this module's in-memory state, while the fake's own
// backing Map persists across that reset — precisely the same relationship
// chrome.storage.local has to a real worker restart.

import { afterEach, describe, expect, it, vi } from "vitest";

function installStorageFake(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(initial));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store.get(key) }),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
          return Promise.resolve();
        },
      },
    },
  };
  return store;
}

describe("publishing-intent", () => {
  afterEach(() => {
    vi.resetModules();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("defaults to false before anything is loaded", async () => {
    installStorageFake();
    const mod = await import("./publishing-intent.js");
    expect(mod.getPublishingIntent()).toBe(false);
  });

  it("loadPersistedPublishingIntent restores a previously-persisted true value", async () => {
    installStorageFake({ "riftsight.publishingIntent": true });
    const mod = await import("./publishing-intent.js");
    await mod.loadPersistedPublishingIntent();
    expect(mod.getPublishingIntent()).toBe(true);
  });

  it("loadPersistedPublishingIntent leaves the default false when nothing was ever persisted — a brand-new profile", async () => {
    installStorageFake();
    const mod = await import("./publishing-intent.js");
    await mod.loadPersistedPublishingIntent();
    expect(mod.getPublishingIntent()).toBe(false);
  });

  it("setPublishingIntent(true) is readable via a fresh module load — simulates a worker restart right after the streamer clicks Start", async () => {
    const store = installStorageFake();
    const mod1 = await import("./publishing-intent.js");
    await mod1.setPublishingIntent(true);
    expect(store.get("riftsight.publishingIntent")).toBe(true);

    vi.resetModules();
    const mod2 = await import("./publishing-intent.js");
    expect(mod2.getPublishingIntent()).toBe(false); // fresh module state, not yet loaded
    await mod2.loadPersistedPublishingIntent();
    expect(mod2.getPublishingIntent()).toBe(true); // now restored from the same underlying storage
  });

  it("setPublishingIntent(false) persists and survives a simulated worker restart — explicit Stop must stick", async () => {
    const store = installStorageFake({ "riftsight.publishingIntent": true });
    const mod1 = await import("./publishing-intent.js");
    await mod1.loadPersistedPublishingIntent();
    expect(mod1.getPublishingIntent()).toBe(true);

    await mod1.setPublishingIntent(false);
    expect(store.get("riftsight.publishingIntent")).toBe(false);

    vi.resetModules();
    const mod2 = await import("./publishing-intent.js");
    await mod2.loadPersistedPublishingIntent();
    expect(mod2.getPublishingIntent()).toBe(false);
  });
});
