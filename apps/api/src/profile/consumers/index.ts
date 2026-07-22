/** Pass 1.5 — registers each real feature consumer against the Research
 * Focus reactive loop, one per response per the brief. Importing this
 * module (once, from server.ts) is the only wiring a new consumer needs.
 *
 * Registering alone only reacts to FUTURE commits; each consumer's cached
 * view must also be primed with whatever profile already exists at boot
 * (e.g. after a server restart), otherwise it stays in its initial empty
 * state until the researcher happens to edit the profile again. */
import { dbReady } from "../../db/client.js";
import { profileProvider } from "../provider.js";
import { consumerRegistry } from "../registry.js";
import { searchConsumer } from "./search.js";
import { recommendationsConsumer } from "./recommendations.js";
import { summariesConsumer } from "./summaries.js";

const consumers = [searchConsumer, recommendationsConsumer, summariesConsumer];

for (const consumer of consumers) consumerRegistry.register(consumer);

async function primeAll(): Promise<void> {
  // Sprint 6 Pass 3: this promise chain starts running the moment this
  // module is imported (at the top of server.ts), independently of and
  // possibly before server.ts's own main() gets to its `await dbReady` —
  // db/client.ts's `db` binding is no longer populated synchronously at
  // import time (it needs its own async init now, for the same SEA/CJS
  // reasons), so this needs to wait for it directly rather than assume
  // it's already there. Caught live: booting straight into a real
  // `TypeError: Cannot read properties of undefined (reading 'select')`
  // the moment this restructure landed.
  await dbReady;
  const profile = await profileProvider.getCurrent();
  for (const consumer of consumers) {
    await consumer.apply(consumer.select(profile));
  }
}

// Sprint 6 Pass 3: not top-level-awaited — see db/client.ts's dbReady for
// the same reasoning (CJS compatibility for the Node SEA build). server.ts's
// main() awaits this before the app starts accepting requests.
export const consumersPrimed = primeAll();
