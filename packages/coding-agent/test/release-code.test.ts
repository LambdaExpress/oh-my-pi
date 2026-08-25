import { describe, expect, it } from "bun:test";
import {
	DEV_BUILD,
	formatVersionWithBuild,
	isBuildUpdateAvailable,
	isDevelopmentBuildCode,
	parseBuildIdentifier,
} from "../src/release-code";

describe("release build identifiers", () => {
	it("parses the local development marker and formats it for the welcome screen", () => {
		expect(isDevelopmentBuildCode("dev")).toBe(true);
		expect(parseBuildIdentifier("dev")).toBe(DEV_BUILD);
		expect(parseBuildIdentifier("42")).toBe(42);
		expect(formatVersionWithBuild("18.0.4", DEV_BUILD)).toBe("18.0.4 Build Dev");
	});

	it("keeps numeric release codes monotonic while development builds remain updateable", () => {
		expect(isBuildUpdateAvailable(7, 7)).toBe(false);
		expect(isBuildUpdateAvailable(7, 8)).toBe(true);
		expect(isBuildUpdateAvailable(DEV_BUILD, 1)).toBe(true);
	});

	it("rejects unknown build markers", () => {
		expect(parseBuildIdentifier("release")).toBeUndefined();
	});
});
