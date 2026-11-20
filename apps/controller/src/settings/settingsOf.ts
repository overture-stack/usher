import type { SettingName, SettingReading, Settings } from './types.js';

/** The reading of every setting, one member per setting. */
export type Readings = { [Name in SettingName]: SettingReading<Settings[Name]> };

/** The reading of every setting but the grant rules. */
export type HeldReadings = Omit<Readings, 'grantRules'>;

// Every setting but the grant rules, once every reading gave one; otherwise none.
export const heldOf = (readings: HeldReadings): Omit<Settings, 'grantRules'> | undefined => {
	const {
		backChannelLogout,
		eventSource,
		firstUser,
		grantAutoAccept,
		heartbeatMilliseconds,
		issuer,
		noticePageLimit,
		noticeRereadMilliseconds,
		retentionGraceSeconds,
		retentionMarginSeconds,
		selfGrantMaximumLifetimeSeconds,
		signInTokenMaximumLifetimeSeconds,
		streamLimitPerAudience,
		streamMaximumLifetimeSeconds,
		streamQueueLimit,
		submitterCategory,
		tokenLifetimeSeconds,
	} = readings;
	return backChannelLogout.kind === 'read' &&
		eventSource.kind === 'read' &&
		firstUser.kind === 'read' &&
		grantAutoAccept.kind === 'read' &&
		heartbeatMilliseconds.kind === 'read' &&
		issuer.kind === 'read' &&
		noticePageLimit.kind === 'read' &&
		noticeRereadMilliseconds.kind === 'read' &&
		retentionGraceSeconds.kind === 'read' &&
		retentionMarginSeconds.kind === 'read' &&
		selfGrantMaximumLifetimeSeconds.kind === 'read' &&
		signInTokenMaximumLifetimeSeconds.kind === 'read' &&
		streamLimitPerAudience.kind === 'read' &&
		streamMaximumLifetimeSeconds.kind === 'read' &&
		streamQueueLimit.kind === 'read' &&
		submitterCategory.kind === 'read' &&
		tokenLifetimeSeconds.kind === 'read'
		? {
				backChannelLogout: backChannelLogout.value,
				eventSource: eventSource.value,
				firstUser: firstUser.value,
				grantAutoAccept: grantAutoAccept.value,
				heartbeatMilliseconds: heartbeatMilliseconds.value,
				issuer: issuer.value,
				noticePageLimit: noticePageLimit.value,
				noticeRereadMilliseconds: noticeRereadMilliseconds.value,
				retentionGraceSeconds: retentionGraceSeconds.value,
				retentionMarginSeconds: retentionMarginSeconds.value,
				selfGrantMaximumLifetimeSeconds: selfGrantMaximumLifetimeSeconds.value,
				signInTokenMaximumLifetimeSeconds: signInTokenMaximumLifetimeSeconds.value,
				streamLimitPerAudience: streamLimitPerAudience.value,
				streamMaximumLifetimeSeconds: streamMaximumLifetimeSeconds.value,
				streamQueueLimit: streamQueueLimit.value,
				submitterCategory: submitterCategory.value,
				tokenLifetimeSeconds: tokenLifetimeSeconds.value,
			}
		: undefined;
};

// Every setting, once every reading gave one; otherwise none.
export const settingsOf = (readings: Readings): Settings | undefined => {
	const held = heldOf(readings);
	const { grantRules } = readings;
	return held !== undefined && grantRules.kind === 'read' ? { ...held, grantRules: grantRules.value } : undefined;
};
