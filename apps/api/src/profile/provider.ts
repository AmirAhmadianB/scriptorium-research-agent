/** Provider — one access path to the current profile, emitting exactly
 * one 'change' event per commit. Deliberately minimal in this pass:
 * debouncing rapid edits and isolating one failing consumer from others
 * are Pass 1.4's job ("Reactive loop"), not this foundation pass's. */
import { EventEmitter } from "node:events";
import type { ResearchProfile } from "@scriptorium/shared";
import { commitProfile, getProfile } from "./store.js";

class ProfileProvider extends EventEmitter {
  async getCurrent(professorId?: string): Promise<ResearchProfile> {
    return getProfile(professorId);
  }

  async commit(input: unknown): Promise<ResearchProfile> {
    const profile = await commitProfile(input);
    this.emit("change", profile);
    return profile;
  }
}

export const profileProvider = new ProfileProvider();
