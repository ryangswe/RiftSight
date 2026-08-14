import type { OverlayState } from "@riftsight/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRedisStateBus, type RedisPubSubClient } from "./redis-state-bus.js";
import type { StateBusMessage } from "./state-bus.js";

/**
 * Records every call this module makes and lets a test simulate an incoming
 * Redis pub/sub message — no real Redis available in this sandbox, so this
 * stands in for it. Deliberately loose (`any`) method signatures rather
 * than literally `implements RedisPubSubClient`: ioredis's real overloaded
 * signatures (variadic channel args, `string | Buffer`, an optional
 * trailing callback) are more than this double needs to fake out — it's
 * cast to `RedisPubSubClient` at the one place createRedisStateBus actually
 * needs that shape, which is all the real contract under test here.
 */
class FakeRedisClient {
  publishCalls: [channel: string, message: string][] = [];
  subscribeCalls: string[] = [];
  setCalls: [key: string, value: string, ...args: (string | number)[]][] = [];
  getCalls: string[] = [];
  quitCalls = 0;
  /** When set, get() resolves this instead of consulting storedValues — lets a test script a specific response (or null miss) without modeling real SET semantics. */
  nextGetResult: string | null | undefined;
  /** When true, set()/get() reject — simulates Redis being unreachable. */
  failCommands = false;
  /** When true, subscribe() rejects — simulates Redis unreachable at construction/boot time. */
  failSubscribe = false;
  private storedValues = new Map<string, string>();
  private messageHandler: ((channel: string, message: string) => void) | undefined;
  /** Every handler registered via on(), by event name — lets tests assert hardening listeners exist and simulate the events firing. */
  readonly eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  publish(channel: string, message: string): Promise<number> {
    this.publishCalls.push([channel, message]);
    return Promise.resolve(1);
  }

  set(key: string, value: string, ...args: (string | number)[]): Promise<"OK"> {
    if (this.failCommands) return Promise.reject(new Error("fake redis unreachable"));
    this.setCalls.push([key, value, ...args]);
    this.storedValues.set(key, value);
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    if (this.failCommands) return Promise.reject(new Error("fake redis unreachable"));
    this.getCalls.push(key);
    if (this.nextGetResult !== undefined) return Promise.resolve(this.nextGetResult);
    return Promise.resolve(this.storedValues.get(key) ?? null);
  }

  subscribe(...channels: string[]): Promise<number> {
    if (this.failSubscribe) return Promise.reject(new Error("fake redis unreachable at subscribe"));
    this.subscribeCalls.push(...channels);
    return Promise.resolve(channels.length);
  }

  on(event: string, cb: (...args: never[]) => void): this {
    if (event === "message") this.messageHandler = cb as (channel: string, message: string) => void;
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(cb as (...args: unknown[]) => void);
    this.eventHandlers.set(event, handlers);
    return this;
  }

  /** Test-only: fires every handler registered for the event, the way ioredis's EventEmitter would. */
  emitEvent(event: string, ...args: unknown[]): void {
    for (const handler of this.eventHandlers.get(event) ?? []) handler(...args);
  }

  quit(): Promise<"OK"> {
    this.quitCalls += 1;
    return Promise.resolve("OK");
  }

  /** Test-only: simulates Redis delivering an incoming pub/sub message to whatever handler was registered via on("message", ...). */
  emitMessage(channel: string, message: string): void {
    this.messageHandler?.(channel, message);
  }

  asRedisPubSubClient(): RedisPubSubClient {
    return this as unknown as RedisPubSubClient;
  }
}

function sampleMessage(sessionId: string): StateBusMessage {
  return {
    kind: "state",
    sessionId,
    originInstanceId: "inst-a",
    state: {
      protocolVersion: 1,
      sessionId,
      sequence: 1,
      capturedAt: Date.now(),
      sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      cards: [],
    },
  };
}

describe("createRedisStateBus", () => {
  it("constructs exactly two distinct clients — one for publishing, one for subscribing", () => {
    const clients: FakeRedisClient[] = [];
    createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });

    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
  });

  it("publish() calls Redis PUBLISH only on the publisher-role client, with the fixed channel and JSON-encoded message", () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });
    const [publisherClient, subscriberClient] = clients;

    const message = sampleMessage("s1");
    bus.publish(message);

    expect(publisherClient!.publishCalls).toEqual([["riftsight:state-bus", JSON.stringify(message)]]);
    expect(subscriberClient!.publishCalls).toEqual([]);
  });

  it("issues exactly one Redis SUBSCRIBE at construction, regardless of how many local handlers subscribe afterward", () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });
    const [, subscriberClient] = clients;

    bus.subscribe(() => {});
    bus.subscribe(() => {});
    bus.subscribe(() => {});

    expect(subscriberClient!.subscribeCalls).toEqual(["riftsight:state-bus"]);
  });

  it("delivers a decoded incoming message to a locally-subscribed handler", () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });
    const [, subscriberClient] = clients;

    const received: StateBusMessage[] = [];
    bus.subscribe((message) => received.push(message));

    const message = sampleMessage("s1");
    subscriberClient!.emitMessage("riftsight:state-bus", JSON.stringify(message));

    expect(received).toEqual([message]);
  });

  it("ignores a message delivered on a different channel", () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });
    const [, subscriberClient] = clients;

    const handler = vi.fn();
    bus.subscribe(handler);

    subscriberClient!.emitMessage("some-other-channel", JSON.stringify(sampleMessage("s1")));

    expect(handler).not.toHaveBeenCalled();
  });

  it("drops malformed JSON on the channel without throwing", () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });
    const [, subscriberClient] = clients;

    const handler = vi.fn();
    bus.subscribe(handler);

    expect(() => subscriberClient!.emitMessage("riftsight:state-bus", "{not valid json")).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  describe("snapshot store", () => {
    function createBusWithClients(): { bus: ReturnType<typeof createRedisStateBus>; clients: FakeRedisClient[] } {
      const clients: FakeRedisClient[] = [];
      const bus = createRedisStateBus("redis://fake", {
        createClient: () => {
          const client = new FakeRedisClient();
          clients.push(client);
          return client.asRedisPubSubClient();
        },
      });
      return { bus, clients };
    }

    const sampleState: OverlayState = {
      protocolVersion: 1,
      sessionId: "s1",
      sequence: 4,
      capturedAt: 1700000000000,
      sourceViewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      cards: [],
    };

    it("saveSnapshot issues SET <key> <json> PX <ttl> on the publisher-role client only", () => {
      const { bus, clients } = createBusWithClients();
      const [publisherClient, subscriberClient] = clients;

      bus.saveSnapshot("s1", sampleState, 45_000);

      expect(publisherClient!.setCalls).toEqual([["riftsight:state:s1", JSON.stringify(sampleState), "PX", 45_000]]);
      expect(subscriberClient!.setCalls).toEqual([]);
    });

    it("loadSnapshot GETs the session's key on the publisher-role client and decodes the stored state", async () => {
      const { bus, clients } = createBusWithClients();
      const [publisherClient, subscriberClient] = clients;

      bus.saveSnapshot("s1", sampleState, 45_000);
      await expect(bus.loadSnapshot("s1")).resolves.toEqual(sampleState);

      expect(publisherClient!.getCalls).toEqual(["riftsight:state:s1"]);
      expect(subscriberClient!.getCalls).toEqual([]);
    });

    it("loadSnapshot resolves null on a key miss (no snapshot ever saved, or Redis already expired it)", async () => {
      const { bus } = createBusWithClients();
      await expect(bus.loadSnapshot("never-saved")).resolves.toBeNull();
    });

    it("loadSnapshot resolves null (not a rejection) for a corrupt stored value", async () => {
      const { bus, clients } = createBusWithClients();
      clients[0]!.nextGetResult = "{not valid json";

      await expect(bus.loadSnapshot("s1")).resolves.toBeNull();
    });

    it("loadSnapshot resolves null (not a rejection) when Redis is unreachable", async () => {
      const { bus, clients } = createBusWithClients();
      clients[0]!.failCommands = true;

      await expect(bus.loadSnapshot("s1")).resolves.toBeNull();
    });

    it("saveSnapshot does not throw or leave an unhandled rejection when Redis is unreachable", async () => {
      const { bus, clients } = createBusWithClients();
      clients[0]!.failCommands = true;

      expect(() => bus.saveSnapshot("s1", sampleState, 45_000)).not.toThrow();
      // Let the rejected SET promise settle — an unhandled rejection here
      // would fail the test run via vitest's unhandled-error reporting.
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe("hardening (a Redis blip must degrade, not crash)", () => {
    function createBusWithClients(): { bus: ReturnType<typeof createRedisStateBus>; clients: FakeRedisClient[] } {
      const clients: FakeRedisClient[] = [];
      const bus = createRedisStateBus("redis://fake", {
        createClient: () => {
          const client = new FakeRedisClient();
          clients.push(client);
          return client.asRedisPubSubClient();
        },
      });
      return { bus, clients };
    }

    it("registers an 'error' listener on BOTH clients at construction (an unlistened EventEmitter error event would crash the process)", () => {
      const { clients } = createBusWithClients();

      for (const client of clients) {
        expect(client.eventHandlers.get("error")?.length ?? 0).toBeGreaterThanOrEqual(1);
        // Firing it is log-only — nothing throws, nothing else happens.
        expect(() => client.emitEvent("error", new Error("connection refused"))).not.toThrow();
      }
    });

    it("logs reconnect attempts on both clients without throwing", () => {
      const { clients } = createBusWithClients();

      for (const client of clients) {
        expect(client.eventHandlers.get("reconnecting")?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(() => client.emitEvent("reconnecting")).not.toThrow();
      }
    });

    it("a failed publish is swallowed (logged) rather than thrown or left as an unhandled rejection", async () => {
      const { bus, clients } = createBusWithClients();
      clients[0]!.failCommands = true;

      expect(() => bus.publish(sampleMessage("s1"))).not.toThrow();
      // Let the rejected PUBLISH promise settle — an unhandled rejection
      // here would fail the run via vitest's unhandled-error reporting.
      await new Promise((resolve) => setImmediate(resolve));
    });

    it("a failed initial SUBSCRIBE is logged, not fatal — construction succeeds and publishing still works", async () => {
      const clients: FakeRedisClient[] = [];
      let clientIndex = 0;
      const bus = createRedisStateBus("redis://fake", {
        createClient: () => {
          const client = new FakeRedisClient();
          // Only the second-constructed (subscriber-role) client fails its
          // subscribe — the publisher connection is healthy.
          client.failSubscribe = clientIndex === 1;
          clientIndex += 1;
          clients.push(client);
          return client.asRedisPubSubClient();
        },
      });
      await new Promise((resolve) => setImmediate(resolve)); // let the rejected subscribe settle

      const message = sampleMessage("s1");
      expect(() => bus.publish(message)).not.toThrow();
      expect(clients[0]!.publishCalls).toEqual([["riftsight:state-bus", JSON.stringify(message)]]);
    });
  });

  it("close() calls quit() on both underlying clients", async () => {
    const clients: FakeRedisClient[] = [];
    const bus = createRedisStateBus("redis://fake", {
      createClient: () => {
        const client = new FakeRedisClient();
        clients.push(client);
        return client.asRedisPubSubClient();
      },
    });

    await bus.close();

    expect(clients[0]!.quitCalls).toBe(1);
    expect(clients[1]!.quitCalls).toBe(1);
  });
});
