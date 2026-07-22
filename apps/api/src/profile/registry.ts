/** Registry — Pass 1.4's reactive loop. On every profile commit, each
 * registered consumer runs its own select(profile) -> derive a feature-
 * specific view, then apply(selected) -> update that feature. Consumers
 * are independent: one throwing must never block the others (isolated via
 * try/catch per consumer, not a single try/catch around the loop). A
 * consumer may declare debounceMs to coalesce rapid successive commits —
 * only the latest profile in the window is applied, and getState() exposes
 * a `pending` flag so callers can show "pending" instead of blocking.
 *
 * No real feature consumer is registered here yet — that's Pass 1.5, one
 * feature per response. The `diagnosticConsumer` below is the brief's
 * "temporary test consumer to observe propagation" for this pass's own
 * Gate: it is debounced and keeps a small ring buffer of what it received,
 * inspectable live via GET /api/research-profile/_consumers. */
import type { ResearchProfile } from "@scriptorium/shared";
import { profileProvider } from "./provider.js";

export interface ProfileConsumer<T = unknown> {
  name: string;
  /** Debounce window in ms. Omitted/0 = apply immediately on every commit. */
  debounceMs?: number;
  /** Derive this feature's view of the profile. Kept separate from apply
   * so a consumer's own tests can exercise select() without side effects. */
  select(profile: ResearchProfile): T;
  apply(selected: T): void | Promise<void>;
}

export interface ConsumerState {
  name: string;
  pending: boolean;
  lastAppliedVersion: number | null;
  lastAppliedAt: string | null;
  lastError: string | null;
}

class ConsumerRegistry {
  private consumers: ProfileConsumer[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private latestProfile = new Map<string, ResearchProfile>();
  private state = new Map<string, ConsumerState>();

  register(consumer: ProfileConsumer): void {
    this.consumers = this.consumers.filter(c => c.name !== consumer.name);
    this.consumers.push(consumer);
    this.state.set(consumer.name, {
      name: consumer.name, pending: false,
      lastAppliedVersion: null, lastAppliedAt: null, lastError: null,
    });
  }

  unregister(name: string): void {
    this.consumers = this.consumers.filter(c => c.name !== name);
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
    this.latestProfile.delete(name);
    this.state.delete(name);
  }

  list(): readonly ProfileConsumer[] {
    return this.consumers;
  }

  getState(): ConsumerState[] {
    return this.consumers.map(c => this.state.get(c.name)!);
  }

  /** Fan out a profile change to every consumer. Immediate consumers run
   * (and are awaited) right away; debounced consumers coalesce into a
   * (re)scheduled timer, so N rapid commits inside one window collapse to
   * exactly one apply(), always with the latest profile. */
  async notifyAll(profile: ResearchProfile): Promise<void> {
    await Promise.all(this.consumers.map(consumer => {
      if (!consumer.debounceMs) return this.applyNow(consumer, profile);
      this.scheduleDebounced(consumer, profile);
      return Promise.resolve();
    }));
  }

  private scheduleDebounced(consumer: ProfileConsumer, profile: ResearchProfile): void {
    this.latestProfile.set(consumer.name, profile);
    const existing = this.timers.get(consumer.name);
    if (existing) clearTimeout(existing);
    this.setState(consumer.name, { pending: true });
    const timer = setTimeout(() => {
      this.timers.delete(consumer.name);
      const latest = this.latestProfile.get(consumer.name);
      if (latest) void this.applyNow(consumer, latest);
    }, consumer.debounceMs);
    this.timers.set(consumer.name, timer);
  }

  private async applyNow(consumer: ProfileConsumer, profile: ResearchProfile): Promise<void> {
    try {
      const selected = consumer.select(profile);
      await consumer.apply(selected);
      this.setState(consumer.name, {
        pending: false, lastError: null,
        lastAppliedVersion: profile.version, lastAppliedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Deliberately swallowed here (not rethrown): a broken consumer must
      // never stop the fan-out to the others. The error is still visible
      // via getState() for diagnosis/tests.
      this.setState(consumer.name, {
        pending: false, lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private setState(name: string, patch: Partial<ConsumerState>): void {
    const prev = this.state.get(name) ?? {
      name, pending: false, lastAppliedVersion: null, lastAppliedAt: null, lastError: null,
    };
    this.state.set(name, { ...prev, ...patch });
  }
}

export const consumerRegistry = new ConsumerRegistry();

profileProvider.on("change", (profile: ResearchProfile) => {
  void consumerRegistry.notifyAll(profile);
});

/** Pass 1.4's temporary observation consumer (see file header). Ring buffer
 * of the last 10 profiles it applied, each tagged with the wall-clock time
 * it was applied at — enough to prove debounced coalescing live: send N
 * rapid commits, then confirm exactly one entry landed per debounce window
 * and it reflects the LAST commit, not an earlier one. */
const DIAGNOSTIC_BUFFER_SIZE = 10;
interface DiagnosticEntry { professorId: string; version: number; keywordCount: number; appliedAt: string }
const diagnosticLog: DiagnosticEntry[] = [];

export const diagnosticConsumer: ProfileConsumer<DiagnosticEntry> = {
  name: "diagnostic",
  debounceMs: 300,
  select(profile) {
    return {
      professorId: profile.professorId, version: profile.version,
      keywordCount: profile.keywords.length, appliedAt: new Date().toISOString(),
    };
  },
  apply(selected) {
    diagnosticLog.push(selected);
    if (diagnosticLog.length > DIAGNOSTIC_BUFFER_SIZE) diagnosticLog.shift();
  },
};

export function getDiagnosticLog(): readonly DiagnosticEntry[] {
  return diagnosticLog;
}

consumerRegistry.register(diagnosticConsumer);
