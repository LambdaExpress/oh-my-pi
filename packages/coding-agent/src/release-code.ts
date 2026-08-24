import { VERSION } from "@oh-my-pi/pi-utils/dirs";

const RELEASE_CODE_VALUE = /^(?:0|[1-9]\d*)$/;
const RELEASE_CODE_TAG = /^code-([1-9]\d*)$/;

/** Parse a non-negative release code without losing integer precision. */
export function parseReleaseCode(value: string | undefined): number | undefined {
	if (!value || !RELEASE_CODE_VALUE.test(value)) return undefined;
	const code = Number(value);
	return Number.isSafeInteger(code) ? code : undefined;
}

/** Parse the numeric code carried by a fork release tag (`code-N`). */
export function parseReleaseCodeTag(tag: string): number | undefined {
	const match = RELEASE_CODE_TAG.exec(tag);
	return match ? parseReleaseCode(match[1]) : undefined;
}

/** Release code embedded by the release workflow; source builds use code 0. */
export const RELEASE_CODE = parseReleaseCode(process.env.OMP_RELEASE_CODE) ?? 0;

/** CLI version keeps the upstream source version while exposing the fork release code. */
export const CLI_VERSION = `${VERSION}+code.${RELEASE_CODE}`;
