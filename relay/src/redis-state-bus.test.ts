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
  quitCalls = 0;
  private messageHandler: ((channel: string, message: string) => void) | undefined;

  publish(channel: string, message: string): Promise<number> {
    this.publishCalls.push([channel, message]);
    return Promise.resolve(1);
  }

  subscribe(...channels: string[]): Promise<number> {
    this.subscribeCalls.push(...channels);
    return Promise.resolve(channels.length);
  }

  on(event: string, cb: (...args: never[]) => void): this {
    if (event === "message") this.messageHandler = cb as (channel: string, message: string) => void;
    return this;
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
  return { kind: "producer-claimed", sessionId, originInstanceId: "inst-a" };
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
