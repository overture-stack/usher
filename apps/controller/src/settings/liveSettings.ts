import type { ControllerConfiguration } from '../configuration/index.js';
import type { SettingsSource } from './createSettingsSource.js';
import type { HeldSettings } from './readStoredSettings.js';
import { signInTokenMaximumOf } from './signInTokenMaximum.js';

/**
 * The Controller's configuration with the stored settings laid over it: each setting it holds reads the
 * source's current value at the moment it is read, so a change the instance rereads takes effect at the
 * next use. The grant rules are not among them: an exchange reads them with its policy. The sign-in
 * token maximum is also judged per token, by {@link ControllerSettings.signInTokenMaximumFor}.
 */
export type ControllerSettings = ControllerConfiguration &
	HeldSettings & {
		/**
		 * The longest lifetime, in seconds, a token issued at an instant may have, judged over every change
		 * of the sign-in token maximum the store recorded: the maximum in force at the issue, and every
		 * later change, the smallest of them. A lowering applies to every token already issued; a raise
		 * only to tokens issued after it.
		 *
		 * @param issuedAt the token's `iat`, in seconds since the Unix epoch.
		 */
		signInTokenMaximumFor(issuedAt: number): number;
	};

/**
 * Lays the stored settings the source holds over the configuration, every setting but the grant rules
 * as a getter, so a read of one returns the value the source holds when it is read.
 *
 * @param configuration the Controller's configuration, read from the environment.
 * @param source the source holding the settings the start read, and rereads, with the sign-in token
 *   maximum's history.
 * @returns the configuration with every held setting read at use.
 */
export const liveSettingsOf = (
	configuration: ControllerConfiguration,
	source: Pick<SettingsSource, 'current' | 'maximumHistory'>,
): ControllerSettings => ({
	...configuration,
	signInTokenMaximumFor(issuedAt: number): number {
		return signInTokenMaximumOf(source.maximumHistory(), issuedAt);
	},
	get backChannelLogout() {
		return source.current().backChannelLogout;
	},
	get eventSource() {
		return source.current().eventSource;
	},
	get firstUser() {
		return source.current().firstUser;
	},
	get grantAutoAccept() {
		return source.current().grantAutoAccept;
	},
	get grantRateThreshold() {
		return source.current().grantRateThreshold;
	},
	get heartbeatMilliseconds() {
		return source.current().heartbeatMilliseconds;
	},
	get issuer() {
		return source.current().issuer;
	},
	get noticePageLimit() {
		return source.current().noticePageLimit;
	},
	get noticeRereadMilliseconds() {
		return source.current().noticeRereadMilliseconds;
	},
	get retentionGraceSeconds() {
		return source.current().retentionGraceSeconds;
	},
	get retentionMarginSeconds() {
		return source.current().retentionMarginSeconds;
	},
	get selfGrantMaximumLifetimeSeconds() {
		return source.current().selfGrantMaximumLifetimeSeconds;
	},
	get signInTokenMaximumLifetimeSeconds() {
		return source.current().signInTokenMaximumLifetimeSeconds;
	},
	get streamLimitPerAudience() {
		return source.current().streamLimitPerAudience;
	},
	get streamMaximumLifetimeSeconds() {
		return source.current().streamMaximumLifetimeSeconds;
	},
	get streamQueueLimit() {
		return source.current().streamQueueLimit;
	},
	get submitterCategory() {
		return source.current().submitterCategory;
	},
	get tokenLifetimeSeconds() {
		return source.current().tokenLifetimeSeconds;
	},
});
