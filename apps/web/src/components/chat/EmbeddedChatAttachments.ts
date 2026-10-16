import { useSyncExternalStore } from "react";

/** Thread-scoped intake for embedded surfaces. Captures the receiver before any decode awaits. */
export class EmbeddedChatAttachments {
  private receivers = new Map<string, (files: File[]) => Promise<void>>();
  private pending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly isPending = (id: string) => this.pending.has(id);
  ready(id: string) {
    return this.receivers.has(id);
  }
  register(id: string, receive: (files: File[]) => Promise<void>) {
    this.receivers.set(id, receive);
    this.emit();
    return () => {
      if (this.receivers.get(id) === receive) {
        this.receivers.delete(id);
        this.emit();
      }
    };
  }
  attach(id: string, files: () => Promise<File[]>) {
    const receive = this.receivers.get(id);
    if (!receive)
      return Promise.reject(new Error("Conversation is loading. Try again when it is ready."));
    const task = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => receive(await files()));
    this.pending.set(id, task);
    this.emit();
    void task
      .finally(() => {
        if (this.pending.get(id) === task) {
          this.pending.delete(id);
          this.emit();
        }
      })
      .catch(() => {});
    return task;
  }
  async wait(id: string) {
    while (this.pending.has(id)) await this.pending.get(id);
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}
const emptySubscribe = () => () => {};
export function useEmbeddedAttachmentPending(
  bridge: EmbeddedChatAttachments | undefined,
  id: string,
) {
  return useSyncExternalStore(
    bridge?.subscribe ?? emptySubscribe,
    () => bridge?.isPending(id) ?? false,
    () => false,
  );
}
