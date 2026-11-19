import type {
	ArtifactAction,
	CategoryPermissions,
	NonEmpty,
	RecordAction,
	RevisionAction,
} from '@overture-stack/usher-types';

import { type HeldEntry, nonEmpty, reachableOf } from './heldEntries.js';
import type { ReachingGrant, ServedResource } from './types.js';

/** What the recorded grants reaching a principal confer on a payload, and what they bound. */
export interface GrantEntries {
	/**
	 * The earliest expiry among the grants drawn on, in whole seconds since the Unix epoch, rounded
	 * down; absent where none of them expires.
	 */
	earliestExpiry?: number;

	/** One entry for each grant drawn on. */
	entries: readonly HeldEntry[];

	/** How many grants were drawn on. */
	grantCount: number;
}

// Each list holds exactly the actions payload version 1 defines for its entity, in the order it
// defines them. No field action is listed, since this code confers none.
const ARTIFACT_ACTIONS: readonly ArtifactAction[] = ['count', 'view', 'export', 'create', 'update', 'delete'];

const RECORD_ACTIONS: readonly RecordAction[] = ['count', 'view', 'export', 'create', 'update', 'delete'];

const REVISION_ACTIONS: readonly RevisionAction[] = ['view', 'export'];

/** A grant drawn on, its entry beside its expiry. */
interface DrawnOn {
	entry: HeldEntry;
	expiresAt: number | null;
}

/**
 * Whether a grant names a field category within its record category, global or its resource's own.
 *
 * @param grant the grant.
 */
export const namesFieldCategory = ({ fieldCategory }: ReachingGrant): boolean => fieldCategory !== null;

// The whole second an instant given in milliseconds falls in.
const secondOf = (milliseconds: number): number => Math.floor(milliseconds / 1000);

// A grant is kept while its holder's latest decision accepts it and it lasts past the second the token
// is issued in, so one lapsing within that second is not.
const isKept = ({ expiresAt, latestDecision }: ReachingGrant, issuedAt: number): boolean =>
	latestDecision?.decision === 'accepted' && (expiresAt === null || secondOf(expiresAt) > issuedAt);

// The actions of one entity a set of capabilities holds, among those given, in their order.
const actionsHeld = <Action extends string>(
	entity: string,
	actions: readonly Action[],
	capabilities: ReadonlySet<string>,
): NonEmpty<Action> | undefined => nonEmpty(actions.filter((action) => capabilities.has(`${entity}.${action}`)));

// What a grant confers under its record category: the capabilities its role carries as read that its
// holder's latest decision accepted, of the actions payload version 1 lists, each under its entity. A
// control-plane role's capabilities never reach a token.
const conferredPermissions = ({
	latestDecision,
	plane,
	roleCapabilities,
}: ReachingGrant): CategoryPermissions | undefined => {
	if (plane === 'data' && latestDecision !== null) {
		const accepted = new Set(latestDecision.capabilities);
		const conferred = new Set(roleCapabilities.filter((capability) => accepted.has(capability)));
		const artifact = actionsHeld('artifact', ARTIFACT_ACTIONS, conferred);
		const record = actionsHeld('record', RECORD_ACTIONS, conferred);
		const revision = actionsHeld('revision', REVISION_ACTIONS, conferred);
		return artifact === undefined && record === undefined && revision === undefined
			? undefined
			: {
					...(artifact === undefined ? {} : { artifact }),
					...(record === undefined ? {} : { record }),
					...(revision === undefined ? {} : { revision }),
				};
	}
	return undefined;
};

// A grant is drawn on where it is kept, names a record category and confers an action on it, and is on
// a resource an entry may be conferred on.
const drawnOn = (grant: ReachingGrant, reachable: ReadonlySet<string>, issuedAt: number): readonly DrawnOn[] => {
	const { expiresAt, externalId, recordCategory } = grant;
	if (recordCategory !== null && reachable.has(externalId) && isKept(grant, issuedAt)) {
		const permissions = conferredPermissions(grant);
		return permissions === undefined
			? []
			: [
					{
						entry: {
							category: `${recordCategory.scope}.${recordCategory.name}`,
							externalId,
							permissions,
						},
						expiresAt,
					},
				];
	}
	return [];
};

/**
 * The entries the recorded grants reaching a signed-in principal confer, at the instant a token is
 * issued. A grant is kept where the principal's latest decision on it accepts it and it expires after
 * the second the token is issued in, or never. A kept grant confers, under its record category, the
 * capabilities its role carries as read that the decision accepted, of the actions payload version 1
 * defines for artifacts, records and revisions, each under its entity; a control-plane role confers
 * none, nor does a grant naming no record category. A grant on a resource the audience does not serve,
 * has retired or has suppressed confers nothing, and one conferring no action is not drawn on. A grant
 * naming a field category confers nothing, and counts in neither `grantCount` nor `earliestExpiry`.
 * Every grant drawn on is counted in `grantCount`, and the earliest of their expiries, rounded down to
 * the whole second, is `earliestExpiry`.
 *
 * @param served every resource the audience serves, retired ones included.
 * @param grants every recorded grant reaching the principal.
 * @param issuedAt the instant the token is issued, in whole seconds since the Unix epoch.
 */
export const grantEntries = (
	served: readonly ServedResource[],
	grants: readonly ReachingGrant[],
	issuedAt: number,
): GrantEntries => {
	const reachable = new Set(reachableOf(served).map(({ externalId }) => externalId));
	const drawn = grants.flatMap((grant) => (namesFieldCategory(grant) ? [] : drawnOn(grant, reachable, issuedAt)));
	const expiries = drawn.flatMap(({ expiresAt }) => (expiresAt === null ? [] : [secondOf(expiresAt)]));
	return {
		...(expiries.length === 0
			? {}
			: {
					earliestExpiry: expiries.reduce((earliest, expiry) => Math.min(earliest, expiry)),
				}),
		entries: drawn.map(({ entry }) => entry),
		grantCount: drawn.length,
	};
};
