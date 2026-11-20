import type { GrantRateThreshold, SettingReading } from './types.js';

// The longest window, the bound the store's retention floor is held to as well.
const LONGEST_WINDOW_SECONDS = 2_147_483_647;

const MEMBERS = 'operationCount,windowSeconds';

const NOT_A_THRESHOLD = 'is not an object holding operationCount and windowSeconds alone';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isWholeNumberWithin = (value: unknown, minimum: number, maximum: number): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/**
 * Reads the grant rate's threshold from its JSON value: an object holding `operationCount`, a whole
 * number of at least 1, and `windowSeconds`, a whole number from 1 to 2147483647, and no other
 * member. Each rule it breaks is named, and none quotes the value.
 *
 * @param value the setting's value as the store holds it.
 */
export const readGrantRateThreshold = (value: unknown): SettingReading<GrantRateThreshold> => {
	if (!isRecord(value) || Object.keys(value).toSorted().join() !== MEMBERS) {
		return { kind: 'refused', rule: NOT_A_THRESHOLD };
	}
	const { operationCount, windowSeconds } = value;
	if (!isWholeNumberWithin(operationCount, 1, Number.MAX_SAFE_INTEGER)) {
		return { kind: 'refused', rule: 'has an operationCount that is not a whole number of at least 1' };
	}
	if (!isWholeNumberWithin(windowSeconds, 1, LONGEST_WINDOW_SECONDS)) {
		return { kind: 'refused', rule: 'has a windowSeconds that is not a whole number from 1 to 2147483647' };
	}
	return { kind: 'read', value: { operationCount, windowSeconds } };
};
