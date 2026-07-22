// Sprint 6 Pass 3 — redirects drizzle-orm/libsql's OWN internal, top-level
// `require("@libsql/client")` (driver.cjs, third-party code we don't
// control) at build time via esbuild's --alias flag.
//
// This is a harmless stub, not a real load: driver.cjs's `import_client`
// binding is only ever dereferenced (`import_client.createClient(...)`)
// inside its convenience overload for "pass drizzle() a raw connection
// string/config and let it construct the client for you" — a code path
// this project never takes (db/client.ts always constructs the real
// @libsql/client instance itself and passes the object straight to
// drizzle()). So the require only needs to not crash, not actually work.
//
// A real require("@libsql/client") crashes here for a different, harder
// reason than the SEA-anchor problem db/client.ts's own load works around:
// @libsql/client's CJS build's internal `require("@libsql/core/config")`
// fails to resolve through this project's exact pnpm layout even in a
// perfectly normal (non-SEA) Node process — verified directly — while the
// equivalent ESM `import()` resolves it correctly every time. db/client.ts
// therefore loads the real package via a dynamic import() (see its own
// comment for why that specifier is deliberately not a plain string
// literal esbuild could still try to resolve), never through this shim.
module.exports = {
  createClient: () => {
    throw new Error(
      "sea-libsql-shim: drizzle-orm/libsql's own createClient() path was " +
      "called, which this project never uses — db/client.ts always passes " +
      "an already-constructed client instead. If this fires, something " +
      "started calling drizzle(url) instead of drizzle(client) somewhere.",
    );
  },
};
