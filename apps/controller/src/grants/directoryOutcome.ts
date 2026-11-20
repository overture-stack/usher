import { ENVIRONMENT_VARIABLES } from '../configuration/index.js';
import type { AddressResolution } from '../directory/index.js';
import { problem } from '../http/index.js';
import type { OperationOutcome } from '../managementApi/index.js';

/**
 * What an operation naming a person by address offers its caller in place of the address: naming a
 * grant's holder by subject, naming a registration's owner by subject, or revoking a submitter's
 * grant by its id.
 */
export type DirectoryAlternative = 'grantById' | 'holderBySubject' | 'ownerBySubject';

// Each alternative as a refusal's detail words it, beside who the operation names by address.
const ALTERNATIVES: Readonly<Record<DirectoryAlternative, { alternative: string; person: string }>> = Object.freeze({
	grantById: {
		alternative: "revoke the submitter's grant by its id, through DELETE /admin/grants/{id}",
		person: 'A submitter',
	},
	holderBySubject: {
		alternative: 'name the holder by subject',
		person: 'A holder',
	},
	ownerBySubject: {
		alternative: 'name the owner by subject',
		person: 'An owner',
	},
});

const CODE = 'directoryUnavailable';

const NOT_CONFIGURED_CODE = 'directoryNotConfigured';

const NOT_CONFIGURED_TITLE = 'Directory not configured';

// The rule an unconfigured instance breaks, naming the four variables that configure a directory.
const NO_DIRECTORY = `Addresses cannot be resolved without a configured directory, which the variables ${[
	ENVIRONMENT_VARIABLES.directoryUrl,
	ENVIRONMENT_VARIABLES.directoryRealm,
	ENVIRONMENT_VARIABLES.directoryClientId,
	ENVIRONMENT_VARIABLES.directoryClientSecret,
].join(', ')} configure;`;

const TITLE = 'Directory unavailable';

const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * How an operation naming a person by address is answered when the directory resolves nothing, the
 * one place the answer is chosen by configuration and its detail by the operation's alternative.
 * With no directory configured, it is answered 503 `directoryNotConfigured` with no `Retry-After`,
 * since no retry on this instance changes it; its detail names the rule that addresses need a
 * configured directory and the alternative, and its event records `failed` at warning, a fault in
 * the configuration rather than in anything broken. With a directory that cannot answer, it is
 * answered 503 `directoryUnavailable` as unavailable, its detail naming the alternative or trying
 * again, and its event records `failed` at error.
 *
 * @param resolution what the directory gave in place of an account.
 * @param offered what the operation offers in place of the address.
 */
export const unresolvedByDirectory = (
	{ kind }: Extract<AddressResolution, { kind: 'unavailable' | 'unconfigured' }>,
	offered: DirectoryAlternative,
): OperationOutcome => {
	const { alternative, person } = ALTERNATIVES[offered];
	return kind === 'unconfigured'
		? {
				kind: 'unavailable',
				problem: problem(NOT_CONFIGURED_CODE, 503, NOT_CONFIGURED_TITLE, `${NO_DIRECTORY} ${alternative}.`),
				severity: 'warning',
			}
		: {
				kind: 'unavailable',
				problem: problem(
					CODE,
					503,
					TITLE,
					`${person} named by address is found through the identity provider's directory, which cannot answer now. ${capitalized(alternative)}, or try again later.`,
				),
				severity: 'error',
			};
};
