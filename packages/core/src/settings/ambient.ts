// The process's settings runtime (#345), for code that has no op context to read one from: the
// approval engine, the release lane's verifier and the claim loop's gate check. Set once at boot
// from the same runtime the server hands to the ops, so what the engine enforces is what an
// operator is shown. Without a boot it is the registry alone (no environment, no file), which is
// what tests and the offline CLI that name no config get.
import { settingsRegistry } from "./definitions";
import { createSettingsRuntime, type SettingsRuntime } from "./resolve";

let current: SettingsRuntime | undefined;

export function setAmbientSettings(rt: SettingsRuntime | undefined): void {
  current = rt;
}

export function ambientSettings(): SettingsRuntime {
  return (current ??= createSettingsRuntime(settingsRegistry));
}
