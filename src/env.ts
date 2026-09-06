// Centralizes environment-variable loading and access so every file that
// needs a config value (Neo4j credentials, server port, API keys, ...)
// reads it the same way, and `.env` only ever gets loaded once regardless
// of which file happens to import this one first.

// `process.loadEnvFile()` is a built-in Node.js function (no extra npm
// package needed) that reads a ".env" file and copies its key=value lines
// into `process.env`. We keep real credentials in `.env` (which is
// git-ignored -- see .env.example for the template committed to the repo)
// so nothing secret ends up in source control.
// Docs: https://nodejs.org/api/process.html#processloadenvfilepath
try {
  process.loadEnvFile();
} catch {
  // If there's no .env file (e.g. in a CI environment that sets real
  // environment variables directly instead), that's fine -- we just fall
  // through and read whatever's already in process.env below.
}

/**
 * Reads a required environment variable, throwing a clear error if it's
 * missing. Written as its own function (rather than a plain `if` check
 * wherever a value is needed) so the return type is `string`, not
 * `string | undefined` -- TypeScript can't tell, just from an `if (!x)
 * throw` at the call site, that `x` is safe to use as a plain string
 * afterward, but it CAN tell that whatever this function returns is
 * always a `string`, since every path through it either throws or returns
 * a checked value.
 */
export function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill in a value.`);
  }
  return value;
}

/** Reads an optional environment variable, falling back to `defaultValue` if it's unset. */
export function getEnvVar(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}
