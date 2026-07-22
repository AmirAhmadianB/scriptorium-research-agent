import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

const DEFAULT_DB_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../data/scriptorium.db");
const DB_PATH = process.env.SCRIPTORIUM_DB_PATH ?? DEFAULT_DB_PATH;

// libsql wants a "file:" URL with forward slashes; a bare Windows path
// (e.g. "E:\...") gets its drive letter misread as a URL scheme otherwise.
export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: `file:${DB_PATH.replace(/\\/g, "/")}` },
});
