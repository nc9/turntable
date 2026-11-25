import { chooseBackend } from "@/api";
import { createFixtureOnboarding } from "@/api/fixture/onboarding";
import { createOnboardingApi, type OnboardingApi } from "@/api/onboarding";
import { sessionEnded } from "@/lib/session";

let api: OnboardingApi | null = null;

/** The onboarding client for this tab: the fixture in fixture mode, else the real API on the cookie. */
export function getOnboardingApi(): OnboardingApi {
  api ??=
    chooseBackend() === "fixture"
      ? createFixtureOnboarding()
      : createOnboardingApi({
          onUnauthenticated: () => {
            sessionEnded();
            window.location.assign("/sign-in");
          },
        });
  return api;
}
