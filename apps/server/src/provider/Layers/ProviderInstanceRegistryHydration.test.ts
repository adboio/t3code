import { DEFAULT_SERVER_SETTINGS, defaultInstanceIdForDriver } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  // Drivers added after the legacy `settings.providers` struct was frozen
  // have no mirror to read; they still have to reach the registry.
  it("registers a default slot for every built-in driver, mirrored or not", () => {
    const merged = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

    for (const driver of BUILT_IN_DRIVERS) {
      const instanceId = defaultInstanceIdForDriver(driver.driverKind);
      expect(merged[instanceId]?.driver).toBe(driver.driverKind);
    }
  });

  it("keeps a user-authored instance over the legacy mirror", () => {
    const instanceId = defaultInstanceIdForDriver(BUILT_IN_DRIVERS[0]!.driverKind);
    const merged = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: BUILT_IN_DRIVERS[0]!.driverKind, config: { marker: true } },
      },
    });

    expect(merged[instanceId]?.config).toEqual({ marker: true });
  });
});
