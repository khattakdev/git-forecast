// Public API of @git-forecast/core. Front ends call forecastStatus() and
// forecastSync(); runGit is exported because the CLI must run Git through
// the same door (CLAUDE.md).

/** Version of the core engine. Keep in sync with package.json when releasing. */
export const coreVersion = "0.1.0";

export { CONFIG_FILE, type ForecastConfig } from "./config.js";
export {
  type ForecastOptions,
  forecastStatus,
  forecastSync,
} from "./forecast.js";
export * from "./git.js";
export * from "./types.js";
