import { vi } from "vitest";

/** Minimal EventSource for tests: records instances and lets a test emit
 * named frames. Install with installMockEventSource(), then
 * MockEventSource.instances[0]!.emit("job", { ... }). */
export class MockEventSource {
  static instances: MockEventSource[] = [];

  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((cb) => cb !== listener));
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function installMockEventSource(): typeof MockEventSource {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  return MockEventSource;
}
