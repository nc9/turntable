// Imported first by main.ts, for its effect: the environment is normalised before any other module
// reads it, including the ones that read it while they load.
import { applyLegacyEnv } from "./legacy-env";

applyLegacyEnv();
