import assert from 'node:assert/strict';

import {
	type Enforcement,
	type KeyRegistration,
	type PermissionsPayload,
	validateRegistration,
} from '@overture-stack/usher-types';

import {
	answerGrant,
	assertSucceeded,
	changeGrantRole,
	createGrant,
	type GrantDecision,
	revokeGrant,
} from '../harness/admin.js';
import {
	CONFORMANCE_APPLICATIONS,
	CONFORMANCE_CONFIGURATIONS,
	type ConformanceConfigurationName,
	CORPUS_ANA,
	CORPUS_ANA_USER,
} from './conformanceCorpus.js';
import { RELAYED_PATHS } from '../harness/containers.js';
import type { ControllerConfiguration } from '../harness/controller.js';
import { exchange, PEOPLE, type Person, readUsherToken } from '../harness/exchange.js';
import type { Harness, HarnessOptions } from '../harness/harness.js';
import {
	type FixtureDecision,
	type FixtureGrant,
	mergedPolicy,
	OWNER_ROLE,
	type PolicyFixture,
	SEEDED_ROLES,
} from '../harness/policy.js';
import { type EvaluatedRecord, matchesSqon } from '../peripherals/sqonEvaluator.js';
import { requestsTo, type StartedBridge, startBridge, type TimingProfileName } from '../harness/vendoredBridge.js';
import { type Cleanup, eventually } from '../harness/waiting.js';

// The fixture and helpers of the conformance tests alone: the conformance corpus replayed against
// the Controller, its expectations rendered by the Bridge, the Bridge's own scenarios and the
// mock's cues caused for real, under test/conformance/, and the gap tests the conformance tests add
// beside the issuance and revocation tests' (`.dev/docs/controller-tests.md` § Conformance). The
// corpus, its configurations and Ana come from conformanceCorpus.ts, and every path, table and wire
// shape from the shared support modules. The people are the corpus's Ana and the shared cast: the
// owner owns every resource of a configuration and makes Ana's grants through the API (the
// contract's `createGrant`), Bo is a second signed-in person, and Cy is the person whose identity a
// test revokes.

/** The person who owns every resource of a conformance configuration and grants Ana through the API. */
export const CORPUS_OWNER: Person = PEOPLE.owner;

/** The fixture name {@link CORPUS_OWNER} is seeded under. */
export const CORPUS_OWNER_USER = 'owner';

/** The label of the application every corpus payload names as its audience, `arranger-prod`. */
export const ARRANGER_PROD = CONFORMANCE_APPLICATIONS.arrangerProd;

/** The label of the application serving `STUDY-A1` alone, `lyric-example`. */
export const LYRIC_EXAMPLE = CONFORMANCE_APPLICATIONS.lyricExample;

/**
 * The test-defined role carrying `artifact.create` alone, for case 27 (`.dev/design/schema.md`
 * § What is not in the first release).
 */
export const ARTIFACT_ROLE = 'artifact-creator';

/** What each role a corpus grant names carries, as `entity.action` names, as the person accepting it is shown. */
export const ROLE_CAPABILITIES: Readonly<Record<'artifactCreator' | 'curator' | 'viewer', readonly string[]>> =
	Object.freeze({
		artifactCreator: Object.freeze(['artifact.create']),
		curator: SEEDED_ROLES.curator.capabilities,
		viewer: SEEDED_ROLES.viewer.capabilities,
	});

/** The policy defining {@link ARTIFACT_ROLE}, by SQL: no operation of the first release defines a role. */
export const ARTIFACT_ROLE_POLICY: PolicyFixture = {
	roles: {
		[ARTIFACT_ROLE]: {
			capabilities: ROLE_CAPABILITIES.artifactCreator,
			plane: 'data',
		},
	},
};

/** The people the scenario suites seed beside Ana and the owner: Bo and Cy of the shared cast. */
export const SCENARIO_POLICY: PolicyFixture = {
	users: {
		bo: { subject: PEOPLE.bo.subject },
		cy: { subject: PEOPLE.cy.subject },
	},
};

/** The corpus's two groups, by the names its README gives them. */
export const CORPUS_GROUPS = Object.freeze({
	G1: 'cardiology',
	G2: 'study readers',
} as const);

/** One of the corpus's groups, by its fixture name. */
export type CorpusGroup = keyof typeof CORPUS_GROUPS;

/** The fixture name of the group member a group case can add as its positive control: Bo. */
export const CONTROL_MEMBER_USER = 'bo';

/** A grant held by one of the corpus's groups, Ana a member, and her answer to it. */
export interface CorpusGroupGrant {
	/** A global category by bare name: `controlled`, `unmarked`. */
	category: string;

	/**
	 * Whether Bo is a member too, having accepted the grant, so a test keeping it out of Ana's payload
	 * shows it conferred on a member who accepted: false by default.
	 */
	controlMember?: boolean;

	/** Ana's answer; none when absent. */
	decision?: FixtureDecision['decision'];

	group: CorpusGroup;

	/** The resource the group and its grant are on, by externalId. */
	resource: string;

	role: string;
}

/**
 * The fixture name of a corpus group's grant.
 *
 * @param group the group.
 */
export const groupGrantName = (group: CorpusGroup): string => `${group}Grant`;

/**
 * The policy of the corpus's group cases (04 to 09, 16, 22), seeded by SQL since groups have no
 * write path in the first release (`.dev/design/schema.md` § What is not in the first release):
 * each group on its grant's resource with Ana a member, its grant, and Ana's answer to it; and, for
 * a positive control, Bo a member too, having accepted it.
 *
 * @param grants each group's grant, one per group.
 */
export const groupGrantPolicy = (...grants: readonly CorpusGroupGrant[]): PolicyFixture =>
	mergedPolicy(
		...grants.map(({ category, controlMember = false, decision, group, resource, role }): PolicyFixture => ({
			decisions: [
				...(decision === undefined
					? []
					: [
							{
								decision,
								grant: groupGrantName(group),
								person: CORPUS_ANA_USER,
							},
						]),
				...(controlMember
					? [
							{
								decision: 'accepted' as const,
								grant: groupGrantName(group),
								person: CONTROL_MEMBER_USER,
							},
						]
					: []),
			],
			grants: {
				[groupGrantName(group)]: {
					category,
					holder: { group },
					resource,
					role,
				},
			},
			groups: {
				[group]: {
					members: controlMember ? [CORPUS_ANA_USER, CONTROL_MEMBER_USER] : [CORPUS_ANA_USER],
					name: CORPUS_GROUPS[group],
					resource,
				},
			},
			users: controlMember ? { [CONTROL_MEMBER_USER]: { subject: PEOPLE.bo.subject } } : {},
		})),
	);

/**
 * A policy giving Ana an accepted grant by SQL, for a scenario that needs her holding something from
 * the start.
 *
 * @param name the grant's fixture name.
 * @param grant the resource, the bare category and the role.
 */
export const acceptedAnaGrant = (
	name: string,
	{
		category,
		resource,
		role,
	}: Pick<FixtureGrant, 'resource' | 'role'> & {
		category: string;
	},
): PolicyFixture => ({
	decisions: [{ decision: 'accepted', grant: name }],
	grants: {
		[name]: { category, holder: { user: CORPUS_ANA_USER }, resource, role },
	},
});

const ownerGrantName = (resource: string): string => `owner:${resource}`;

const ownedByTheOwner = (fixture: PolicyFixture): PolicyFixture => {
	const resources = Object.keys(fixture.resources ?? {});
	return {
		decisions: resources.map((resource): FixtureDecision => ({
			decision: 'accepted',
			grant: ownerGrantName(resource),
		})),
		grants: Object.fromEntries(
			resources.map((resource): [string, FixtureGrant] => [
				ownerGrantName(resource),
				{
					category: null,
					holder: { user: CORPUS_OWNER_USER },
					resource,
					role: OWNER_ROLE,
				},
			]),
		),
		users: { [CORPUS_OWNER_USER]: { subject: CORPUS_OWNER.subject } },
	};
};

/** What a conformance harness takes beyond the configuration's name. */
export interface ConformanceHarness {
	/** A Valkey of the suite's own, flushed for the case: the run's shared one by default. */
	cacheUrl?: string;

	/** Fields over the configuration's own, such as a timing profile's Controller half. */
	configuration?: Partial<ControllerConfiguration>;

	/** Policy seeded by SQL over the configuration's. */
	policy?: PolicyFixture;
}

/**
 * The harness options of one of the corpus's configurations (`conformanceCorpus.ts`): its
 * applications, its configuration with the test's fields over it, and its policy with the owner's
 * accepted owner grant on each of its resources, and the test's policy, over it.
 *
 * @param name the configuration.
 * @param harness a cache, fields over the configuration, and policy over its fixture.
 */
export const conformanceHarnessOptions = (
	name: ConformanceConfigurationName,
	{ cacheUrl, configuration = {}, policy = {} }: ConformanceHarness = {},
): HarnessOptions => {
	const chosen = CONFORMANCE_CONFIGURATIONS[name];
	return {
		applications: chosen.applications,
		configuration: {
			...chosen.configuration,
			...configuration,
			...(cacheUrl === undefined ? {} : { cacheUrl }),
		},
		fixture: mergedPolicy(chosen.fixture, ownedByTheOwner(chosen.fixture), policy),
	};
};

/** A grant to Ana a test writes through the API, as the resource's owner. */
export interface AnaGrant {
	/** A global category by bare name: `controlled`, `unmarked`. */
	category: string;

	/** An instant with an offset; none when absent. */
	expiresAt?: string;

	/** By externalId. */
	resource: string;

	role: string;
}

/**
 * Creates a grant to Ana through the API as the resource's owner (the contract's `createGrant`),
 * awaiting her answer unless auto-accept is on.
 *
 * @param harness the running harness.
 * @param grant the resource, the category, the role and the expiry.
 * @returns the grant's id, as the creation answered it.
 */
export const grantToAna = async (
	harness: Harness,
	{ category, expiresAt, resource, role }: AnaGrant,
): Promise<string> => {
	const owner = harness.caller(await harness.tokens.management(CORPUS_OWNER));
	const created = await createGrant(owner, {
		category: `global.${category}`,
		...(expiresAt === undefined ? {} : { expiresAt }),
		holder: { subject: CORPUS_ANA.subject },
		resource,
		role,
	});
	assertSucceeded(created, `granting Ana ${role} on ${resource}`);
	if (created.grantId === undefined) {
		return assert.fail("the grant's creation answered no id");
	}
	return created.grantId;
};

/**
 * Answers a grant as Ana through the API, showing the capabilities given.
 *
 * @param harness the running harness.
 * @param grantId the grant's id.
 * @param decision her answer.
 * @param capabilities what she was shown, as `entity.action` names.
 */
export const answerAsAna = async (
	harness: Harness,
	grantId: string,
	decision: GrantDecision['decision'],
	capabilities: readonly string[],
): Promise<void> => {
	const ana = harness.caller(await harness.tokens.management(CORPUS_ANA));
	assertSucceeded(await answerGrant(ana, grantId, { capabilities, decision }), `Ana's answer, ${decision}`);
};

/**
 * Revokes a grant through the API as the resource's owner.
 *
 * @param harness the running harness.
 * @param grantId the grant's id.
 */
export const revokeAsOwner = async (harness: Harness, grantId: string): Promise<void> => {
	const owner = harness.caller(await harness.tokens.management(CORPUS_OWNER));
	assertSucceeded(await revokeGrant(owner, grantId), 'the revocation');
};

/**
 * Changes a grant's role through the API as the resource's owner (the contract's `changeGrant`,
 * ruled), with `PATCH /admin/grants/{grantId}`.
 *
 * @param harness the running harness.
 * @param grantId the grant's id.
 * @param role the role's name.
 */
export const changeRoleAsOwner = async (harness: Harness, grantId: string, role: string): Promise<void> => {
	const owner = harness.caller(await harness.tokens.management(CORPUS_OWNER));
	assertSucceeded(await changeGrantRole(owner, grantId, role), `the change to ${role}`);
};

/** Who a replayed exchange is for, and through which application. */
export interface ReplayedExchange {
	/** The application exchanging: `arranger-prod` by default. */
	application?: string;

	/** Ana, or `null` for the anonymous exchange. */
	person: Person | null;
}

/**
 * Exchanges as the Bridge's client does and reads the token as the Bridge's reader does, failing the
 * test with the status or the reader's reason when no payload is issued.
 *
 * @param harness the running harness.
 * @param exchanged who exchanges, and through which application.
 */
export const replayedPayload = async (
	harness: Harness,
	{ application = ARRANGER_PROD, person }: ReplayedExchange,
): Promise<PermissionsPayload> => {
	const answer = await exchange(harness.url, {
		application: harness.application(application),
		credential: person === null ? null : await harness.tokens.signIn(person, { application }),
	});
	assert.equal(answer.status, 200, `the exchange for ${application} was answered ${answer.status}`);
	const reading = await readUsherToken(answer.body, {
		application: harness.application(application),
		issuer: harness.configuration.issuer,
	});
	if (reading.kind === 'payload') {
		return reading.payload;
	}
	return assert.fail(`the bridge's reader refuses the token: ${reading.reason}`);
};

/** The key a conformance expectation's registration is registered under at the Bridge. */
export const EXPECTATION_KEY = 'files';

/**
 * A conformance expectation's key, as the Bridge registers keys: usher-types' `validateRegistration`
 * accepting it, under {@link EXPECTATION_KEY}.
 *
 * @param keyRegistration the expectation's `keyRegistration`, as the corpus holds it.
 */
export const registeredKey = (keyRegistration: unknown): Readonly<Record<string, KeyRegistration>> => {
	const validated = validateRegistration(keyRegistration);
	if (validated.success) {
		return { [EXPECTATION_KEY]: validated.registration };
	}
	return assert.fail(
		`usher-types refuses the expectation's key: ${validated.problems
			.map(({ position, rule }) => `${position}: ${rule}`)
			.join('; ')}`,
	);
};

/** What happens to one record, as the corpus's expectations name it. */
export type RecordOutcome = 'denied' | 'served' | 'withheld';

/**
 * What the Bridge's enforcement does to one record, as the Bridge's own conformance test reads it
 * (`rendering.conformance.test.ts` `outcomeOf`): an allow serves it, a deny refuses the catalogue,
 * and a narrowing serves it only when usher-types' SQON evaluator matches it
 * (`.dev/docs/controller-tests.md` § Conformance). A test asserts the access holds a result for the
 * key before reading one, since an adapter reads a missing result as a deny.
 *
 * @param enforcement the key's result in the request's access.
 * @param record the record's values by field name.
 */
export const outcomeOf = (enforcement: Enforcement, record: EvaluatedRecord): RecordOutcome => {
	switch (enforcement.kind) {
		case 'allow':
			return 'served';
		case 'deny':
			return 'denied';
		case 'narrow':
			return matchesSqon(enforcement.sqon, record) ? 'served' : 'withheld';
	}
};

/**
 * A record as the support's default key, `vendoredBridge.ts`'s `DEFAULT_RECORD_KEY`, reads one (its
 * `DEFAULT_KEY_REGISTRATIONS`): its resource in `study_id`, and its global category's bare name in
 * `data_category`.
 *
 * @param resource the resource's externalId.
 * @param category the global category's bare name: `controlled`.
 */
export const defaultKeyRecord = (resource: string, category: string): EvaluatedRecord => ({
	data_category: category,
	study_id: resource,
});

/** The timing profile the conformance suites start their Bridges on: the Bridge's own defaults. */
export const CONFORMANCE_PROFILE: TimingProfileName = 'ims';

/** What starting a conformance Bridge takes beyond the harness. */
export interface ConformanceBridge {
	/** The application the Bridge serves: `arranger-prod` by default. */
	application?: string;

	/** The keys registered before the start: the support's default by default. */
	registrations?: Readonly<Record<string, KeyRegistration>>;
}

/**
 * Starts a Bridge against the harness's Controller, on {@link CONFORMANCE_PROFILE}, with the
 * recording fetch and logger, and defers its stop to the cleanup given.
 *
 * @param scope the test's cleanup, which stops the Bridge before the harness.
 * @param harness the running harness.
 * @param bridge the application and the keys.
 */
export const startConformanceBridge = async (
	scope: Cleanup,
	harness: Harness,
	{ application = ARRANGER_PROD, registrations }: ConformanceBridge = {},
): Promise<StartedBridge> => {
	const started = await startBridge({
		application: harness.application(application),
		controllerUrl: harness.url,
		issuer: harness.configuration.issuer,
		profile: CONFORMANCE_PROFILE,
		...(registrations === undefined ? {} : { registrations }),
	});
	scope.defer(() => started.stop());
	return started;
};

/**
 * Waits until a Bridge has started its push, failing the test when it has not within the time given.
 * A notice committed from then on reaches the push, live or in its replay from the head it opened at.
 *
 * @param bridge the Bridge.
 * @param timeoutMs the most to wait.
 */
export const untilPushStarted = async (bridge: StartedBridge, timeoutMs: number): Promise<void> => {
	assert.ok(
		await eventually(() => Promise.resolve(requestsTo(bridge, RELAYED_PATHS.stream).length > 0), timeoutMs, 20),
		'the bridge never opened its push',
	);
};
