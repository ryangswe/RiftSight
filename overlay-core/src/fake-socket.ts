import type { WebSocketLike } from "./relay-socket.js";

/**
 * Minimal test double for the WebSocket surface RelaySocket touches — the
 * real WebSocket doesn't exist as a Node global, so this is what lets
 * RelaySocket/MockOverlayStateSource/TwitchOverlayStateSource be
 * unit-tested at all despite ultimately wrapping a browser API.
 */
export class FakeSocket implements WebSocketLike {
  sentMessages: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  triggerOpen(): void {
    this.emit("open", {});
  }

  triggerMessage(data: string): void {
    this.emit("message", { data });
  }
}
