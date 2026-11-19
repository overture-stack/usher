import { problem, type Problem } from '../http/index.js';

/** The refusals the settings operations answer beyond the Management API's own. */
export const SETTINGS_PROBLEMS = Object.freeze({
	backChannelLogoutNeedsAudiences: problem(
		'backChannelLogoutNeedsAudiences',
		409,
		'Back-channel logout needs audiences',
		'The backChannelLogout setting cannot be on while USHER_BACK_CHANNEL_LOGOUT_AUDIENCES is empty: list the platform client identifiers there, or set backChannelLogout to false.',
	),
	changeLocksOutCaller: problem(
		'changeLocksOutCaller',
		409,
		'Change locks out the caller',
		"The caller's own access token would fail under the new signInTokenMaximumLifetimeSeconds, so the change is refused. Request a change the caller's token can meet.",
	),
	storedSettingsInvalid: problem(
		'storedSettingsInvalid',
		503,
		'Stored settings invalid',
		'A stored setting breaks its rule, so the settings cannot be answered. Correct its row in the store, then try again.',
	),
}) satisfies Readonly<Record<string, Problem>>;
