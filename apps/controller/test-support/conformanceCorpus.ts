import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { type PermissionsPayload, validatePayload } from '@overture-stack/usher-types';

import type { ControllerConfiguration } from './controller.js';
import type { Person } from './exchange.js';
import type { HarnessOptions } from './harness.js';
import type { PolicyFixture } from './policy.js';

// What #215 needs of the conformance corpus: the static case lists its tests register from, the
// reader of the corpus's entries, the payload comparison, the configurations the corpus was computed
// against, and Ana. The corpus itself is read only inside a test body, never at module load.

/**
 * Where the corpus lives: `.dev/design/conformance/` at the repository's root, in its corrected form
 * (#215 Q2: the baseline and the signed-in rule grant read, count, view and export).
 */
export const CORPUS_DIRECTORY = new URL('../../../.dev/design/conformance/', import.meta.url);

/** The corpus's two files, by their names in {@link CORPUS_DIRECTORY}. */
export const CORPUS_FILES = Object.freeze({
	expectations: 'expectations.json',
	principals: 'principals.json',
} as const);

/** A configuration's name, as #215's plan names it. */
export type ConformanceConfigurationName = "A'" | 'A' | 'A-auto' | 'A-off' | 'B' | 'B-off';

/**
 * The corpus's cases, from #215's plan as the rulings settle it, so a test file registers its tests
 * from this list and never from the corpus file:
 *
 * - `replayed`: every case run against the Controller, with the configuration it runs under;
 * - `unreachable`: every entry `principals.json` holds that no test replays, with why;
 * - `omitted`: every case the corpus lists under `omitted`, holding no payload, with what tests it.
 *
 * Every entry of the corpus is in exactly one of the three, which #215's first test checks against the
 * file itself, inside its body.
 */
export const CORPUS_CASES: Readonly<{
	omitted: Readonly<Record<string, string>>;
	replayed: Readonly<Record<string, ConformanceConfigurationName>>;
	unreachable: Readonly<Record<string, string>>;
}> = Object.freeze({
	omitted: Object.freeze({
		'25': 'a grant pairing record.delete with a field category is refused at writing, so no token exists: #212 and #207 test the refusal',
		'33': "a revoked identity is refused 403 at the exchange, so no payload exists: the exchange's 403 test replays it, and her payload once the revocation is lifted",
		'34': "a sign-in token past its exp is refused 403 at the exchange, so no payload exists: the exchange's 403 test replays it",
	}),
	replayed: Object.freeze({
		'01': 'A-off',
		'02': 'A',
		'03': 'A',
		'04': 'A',
		'05': 'A',
		'06': 'A',
		'07': 'A',
		'08': 'A',
		'09': 'A',
		'10': 'A',
		'11': 'A',
		'12': 'A',
		'13': 'A',
		'14': 'A',
		'15': 'A',
		'16': 'A',
		'18': 'A',
		'19': "A'",
		'19b': "A'",
		'20': 'A-auto',
		'22': 'A',
		'23': 'A',
		'24c': 'A',
		'27': 'A',
		'28': 'B',
		'29': 'B-off',
		'30': 'B',
		'31': 'B-off',
		'32': 'B',
		'35': 'B',
	}),
	unreachable: Object.freeze({
		'17': 'resource categories ship after the first release (#211 Q10), and a global category applies to every resource (O16), so no resource stops offering one: unreachable until resource categories ship (B2)',
		'21': "the corpus marks it not yet implementable: nothing can withhold yet, and its payload is case 05's (token-calculation.md, case 21)",
		'24': 'field categories are post-MVP and unconfigured in the first release (B2, #215 Q6)',
		'24b': 'field categories are post-MVP and unconfigured in the first release (B2, #215 Q6)',
		'26': 'revision is post-MVP, so no role carries revision.view (B2, #215 Q6)',
	}),
});

/**
 * The cases `expectations.json` holds, each a `principalId` of a replayed case, so a test file
 * registers its expectations tests without reading the file: four, as the corpus's README lists them.
 */
export const EXPECTATION_CASES: readonly string[] = Object.freeze(['01', '10', '22', '23']);

/** One entry of `principals.json`: a principal's payload, computed against one of the corpus's configurations. */
export interface CorpusEntry {
	/** The case's number, as `token-calculation.md` numbers it: `01`, `19b`. */
	case: string;

	/** `signed-in rule` for an entry computed against the second configuration; absent for the first. */
	configuration?: string;

	description: string;

	/** `case-` and the case's number. */
	id: string;

	/** `false` for a case written before its mechanism; absent otherwise. */
	implementable?: boolean;

	/** The payload, as usher-types' `validatePayload` accepts it. */
	payload: PermissionsPayload;
}

/** One record an expectations case judges, and the outcome the corpus expects for it. */
export interface CorpusRecord {
	/** Its values by field name, the key's resource field among them. */
	fields: Readonly<Record<string, unknown>>;

	outcome: 'denied' | 'served' | 'withheld';
	reason: string;
}

/** One case of `expectations.json`: a key, the principal whose payload it is judged under, and its records. */
export interface CorpusExpectation {
	/** The key, as usher-types' `validateRegistration` accepts it. */
	keyRegistration: unknown;

	/** The `principals.json` entry supplying the payload, as `case-10`. */
	principalId: string;

	records: readonly CorpusRecord[];
}

/** Every case the corpus names, as #215's first test checks them against {@link CORPUS_CASES}. */
export interface CorpusIndex {
	/** Each entry's case number, in the file's order. */
	entries: readonly string[];

	/** Each omitted case's number, in the file's order. */
	omitted: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const member = (value: unknown, name: string): unknown =>
	isRecord(value) && Object.hasOwn(value, name) ? value[name] : undefined;

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const corpusFailure = (file: string, problem: string): Error =>
	new Error(
		`the conformance corpus (.dev/design/conformance/${file}) ${problem}: the suites read its corrected form, kept at that path in the repository`,
	);

const readCorpusFile = (file: string, directory: URL): unknown => {
	const read = ((): { text: string } | undefined => {
		try {
			return { text: readFileSync(new URL(file, directory), 'utf8') };
		} catch {
			return undefined;
		}
	})();
	if (read === undefined) {
		throw corpusFailure(file, 'is missing here');
	}
	try {
		return JSON.parse(read.text) as unknown;
	} catch {
		throw corpusFailure(file, 'is not JSON here');
	}
};

const UNMARKED = 'global.unmarked';

// An anonymous principal holds what the baseline confers and nothing else, so an anonymous entry
// granting view alone on unmarked records is the baseline before #215 Q2 corrected it to read.
const grantsViewAlone = (entry: unknown): boolean => {
	const payload = member(entry, 'payload');
	const permissions = member(payload, 'permissions');
	return (
		member(payload, 'sub') === null &&
		isRecord(permissions) &&
		Object.values(permissions).some((categories) => {
			const actions = member(member(categories, UNMARKED), 'record');
			return Array.isArray(actions) && actions.length > 0 && actions.every((action) => action === 'view');
		})
	);
};

// The corrected corpus holds expectations.json beside principals.json, and its baseline grants read
// (#215 Q2). The form this branch held before the branches meet lacks both, and every payload replayed
// against it would differ from what a correct Controller issues, so it is refused before any is
// compared, and no difference can be read as the Controller's.
const currentPrincipals = (directory: URL): unknown => {
	const principals = readCorpusFile(CORPUS_FILES.principals, directory);
	readCorpusFile(CORPUS_FILES.expectations, directory);
	if (listOf(member(principals, 'principals')).some(grantsViewAlone)) {
		throw corpusFailure(CORPUS_FILES.principals, 'is the old corpus here, its baseline granting view alone');
	}
	return principals;
};

/**
 * Every case the corpus's `principals.json` names, entries and omitted cases apart. Call it inside a
 * test body, never at module load: this is where #215 reads the corpus.
 *
 * @param directory where the corpus is: {@link CORPUS_DIRECTORY} by default.
 * @throws naming the corpus and the branch its corrected form comes with, while a file is missing or
 *   unreadable, or the corpus is its old form: no `expectations.json`, or an anonymous entry, which
 *   holds what the baseline confers, granting view alone.
 */
export const readCorpusIndex = (directory: URL = CORPUS_DIRECTORY): CorpusIndex => {
	const principals = currentPrincipals(directory);
	return {
		entries: listOf(member(principals, 'principals')).map((entry) => String(member(entry, 'case'))),
		omitted: listOf(member(principals, 'omitted')).map((entry) => String(member(entry, 'case'))),
	};
};

/**
 * One case's entry in the corpus's `principals.json`, its payload checked by usher-types'
 * `validatePayload`. Call it inside a test body, never at module load: this is where #215 reads the
 * corpus, and each test reading it marks the place with a short comment naming the corpus.
 *
 * @param caseNumber the case, as `token-calculation.md` numbers it: `05`, `19b`.
 * @param directory where the corpus is: {@link CORPUS_DIRECTORY} by default.
 * @throws naming the corpus and the branch its corrected form comes with, while a file is missing or
 *   unreadable, the corpus is its old form (see {@link readCorpusIndex}), or it holds no entry for the
 *   case, or one whose payload is not version 1's.
 */
export const readCorpusEntry = (caseNumber: string, directory: URL = CORPUS_DIRECTORY): CorpusEntry => {
	const entry = listOf(member(currentPrincipals(directory), 'principals')).find(
		(candidate) => member(candidate, 'case') === caseNumber,
	);
	if (entry === undefined) {
		throw corpusFailure(CORPUS_FILES.principals, `holds no entry for case ${caseNumber} here`);
	}
	const validated = validatePayload(member(entry, 'payload'));
	if (!validated.success) {
		throw corpusFailure(
			CORPUS_FILES.principals,
			`holds case ${caseNumber} here in a form usher-types' validatePayload refuses`,
		);
	}
	const configuration = member(entry, 'configuration');
	const implementable = member(entry, 'implementable');
	return {
		case: caseNumber,
		...(typeof configuration === 'string' ? { configuration } : {}),
		description: String(member(entry, 'description')),
		id: String(member(entry, 'id')),
		...(typeof implementable === 'boolean' ? { implementable } : {}),
		payload: validated.payload,
	};
};

const OUTCOMES: readonly CorpusRecord['outcome'][] = ['denied', 'served', 'withheld'];

const isOutcome = (value: unknown): value is CorpusRecord['outcome'] => OUTCOMES.some((outcome) => outcome === value);

/**
 * One case of the corpus's `expectations.json`, by the case number of the principal it judges. Call
 * it inside a test body, never at module load: this is where #215 reads the corpus's expectations.
 *
 * @param caseNumber the case: `01`, `10`, `22` or `23`.
 * @param directory where the corpus is: {@link CORPUS_DIRECTORY} by default.
 * @throws naming the corpus and the branch its corrected form comes with, while a file is missing or
 *   unreadable, the corpus is its old form (see {@link readCorpusIndex}), or it holds no case for that
 *   principal, or a record whose outcome it does not name.
 */
export const readCorpusExpectation = (caseNumber: string, directory: URL = CORPUS_DIRECTORY): CorpusExpectation => {
	const principalId = `case-${caseNumber}`;
	currentPrincipals(directory);
	const found = listOf(member(readCorpusFile(CORPUS_FILES.expectations, directory), 'cases')).find(
		(candidate) => member(candidate, 'principalId') === principalId,
	);
	if (found === undefined) {
		throw corpusFailure(CORPUS_FILES.expectations, `holds no case for ${principalId} here`);
	}
	const records = listOf(member(found, 'records')).map((record) => {
		const fields = member(record, 'fields');
		const outcome = member(record, 'outcome');
		if (isRecord(fields) && isOutcome(outcome)) {
			return { fields, outcome, reason: String(member(record, 'reason')) };
		}
		throw corpusFailure(
			CORPUS_FILES.expectations,
			`holds a record of ${principalId} here with no fields or no outcome it names`,
		);
	});
	return {
		keyRegistration: member(found, 'keyRegistration'),
		principalId,
		records,
	};
};

type ComparableEntity = readonly string[] | Readonly<Record<string, readonly string[]>>;

/**
 * A payload as #215 compares it with the corpus's: `payloadVersion`, `sub`, `iss` and `aud` as they
 * are; `permissions` by resource, category and entity, each entity's actions as a set (sorted), a
 * field entity's by field category; `globalCategories`, `servedResources` and each
 * `resourceCategories` list as sets (sorted, #215 Q8); and no temporal claim, since the corpus's
 * instants are fixed and illustrative.
 */
export interface ComparablePayload {
	aud: string;
	globalCategories: readonly string[];
	iss: string;
	payloadVersion: number;
	permissions: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, ComparableEntity>>>>>>;
	resourceCategories: Readonly<Record<string, readonly string[]>>;
	servedResources: readonly string[];
	sub: string | null;
}

const asSet = (values: readonly string[]): readonly string[] => [...new Set(values)].toSorted();

const comparableEntity = (held: unknown): ComparableEntity =>
	Array.isArray(held)
		? asSet(held.map(String))
		: Object.fromEntries(
				Object.entries(isRecord(held) ? held : {}).map(([category, actions]) => [
					category,
					asSet(listOf(actions).map(String)),
				]),
			);

/**
 * The form of a payload #215 compares with the corpus's: see {@link ComparablePayload}.
 *
 * @param payload a payload `validatePayload` accepted.
 */
export const comparablePayload = ({
	aud,
	globalCategories,
	iss,
	payloadVersion,
	permissions,
	resourceCategories,
	servedResources,
	sub,
}: PermissionsPayload): ComparablePayload => ({
	aud,
	globalCategories: asSet(globalCategories),
	iss,
	payloadVersion,
	permissions: Object.fromEntries(
		Object.entries(permissions).map(([resource, categories]) => [
			resource,
			Object.fromEntries(
				Object.entries(categories).map(([category, entities]) => [
					category,
					Object.fromEntries(
						Object.entries(entities).map(([entity, held]) => [entity, comparableEntity(held)]),
					),
				]),
			),
		]),
	),
	resourceCategories: Object.fromEntries(
		Object.entries(resourceCategories).map(([resource, categories]) => [resource, asSet(categories)]),
	),
	servedResources: asSet(servedResources),
	sub,
});

/**
 * What gives the id of an application the corpus names by label, as its payloads name their audience
 * `arranger-prod`: a harness, which registered the application under that label.
 */
export interface CorpusAudiences {
	application(label: string): { id: string };
}

/**
 * Asserts that a payload the Controller issued conforms to the corpus's (#215's payload comparison):
 * usher-types' `validatePayload` accepts it, and its {@link comparablePayload} equals the corpus
 * payload's, the corpus's `aud`, an application's label, read as the id that application was
 * registered under. Temporal claims are never compared here; the temporal test bounds them.
 *
 * @param issued the payload the Controller issued, decrypted and not yet trusted.
 * @param entry the corpus's entry.
 * @param audiences what gives the registered id of the application the corpus names: the harness.
 * @throws an assertion error naming the problems `validatePayload` found, or the difference.
 */
export const assertConformsToCorpus = (issued: unknown, entry: CorpusEntry, audiences: CorpusAudiences): void => {
	const validated = validatePayload(issued);
	if (!validated.success) {
		assert.fail(
			`the payload issued for case ${entry.case} is not version 1's: ${validated.problems
				.map(({ position, rule }) => `${position}: ${rule}`)
				.join('; ')}`,
		);
	}
	assert.deepEqual(
		comparablePayload(validated.payload),
		{
			...comparablePayload(entry.payload),
			aud: audiences.application(entry.payload.aud).id,
		},
		`the payload issued for case ${entry.case} differs from the corpus's`,
	);
};

/** The Controller's issuer, which every corpus payload names. */
export const CONFORMANCE_ISSUER = 'https://usher.example.org';

/**
 * The labels of the two applications the corpus's harness registers, each given its id and a fresh
 * key by its registration: `arranger-prod`, the label every corpus payload names its audience by, and
 * `lyric-example`, which serves `STUDY-A1` alone.
 */
export const CONFORMANCE_APPLICATIONS = Object.freeze({
	arrangerProd: 'arranger-prod',
	lyricExample: 'lyric-example',
} as const);

/**
 * Ana, the corpus's principal: the subject every signed-in corpus payload names, and an example.org
 * address. Her sign-in tokens come from the stand-in, Keycloak-shaped as #215's plan lists (RS256 with
 * `kid`, the realm's path as `iss`, `aud` a list naming the application, `azp`), through the harness's
 * `tokens.signIn`.
 */
export const CORPUS_ANA: Person = Object.freeze({
	email: 'ana.corpus@example.org',
	subject: '8f14e45f-ceea-467a-9c1a-1b0e4d9c6f2b',
});

/** The fixture name {@link CORPUS_ANA} is seeded under in every configuration, for a case's grants to hold. */
export const CORPUS_ANA_USER = 'ana';

/** What one configuration gives a harness: its applications, its configuration and its policy. */
export type ConformanceConfiguration = Readonly<
	Required<Pick<HarnessOptions, 'applications' | 'configuration' | 'fixture'>>
>;

const READ: ControllerConfiguration['baseline'] = ['count', 'view', 'export'];

const FIRST_TABLE_SERVED = Object.freeze(['HEART_STUDY', 'LUNG_COHORT', 'REEF_ARCHIVE', 'VOID_INDEX']);

const firstTable = (heartStudyTier: 'grant' | 'open'): PolicyFixture => ({
	applications: {
		[CONFORMANCE_APPLICATIONS.arrangerProd]: { serves: FIRST_TABLE_SERVED },
		[CONFORMANCE_APPLICATIONS.lyricExample]: { serves: ['STUDY-A1'] },
	},
	categories: { 'community-governed': {}, controlled: {} },
	resources: {
		HEART_STUDY: { baseTier: heartStudyTier, name: 'Heart study' },
		LUNG_COHORT: { baseTier: 'open', name: 'Lung cohort' },
		REEF_ARCHIVE: { baseTier: 'open', name: 'Reef archive' },
		'STUDY-A1': { baseTier: 'grant', name: 'Study A1' },
		VOID_INDEX: { baseTier: 'grant', name: 'Void index' },
	},
	users: { [CORPUS_ANA_USER]: { subject: CORPUS_ANA.subject } },
});

const SIGNED_IN_TABLE: PolicyFixture = {
	applications: {
		[CONFORMANCE_APPLICATIONS.arrangerProd]: {
			serves: ['OPEN_ATLAS', 'MEMBERS_ARCHIVE', 'SEALED_ARCHIVE', 'HEART_STUDY'],
		},
		[CONFORMANCE_APPLICATIONS.lyricExample]: { serves: [] },
	},
	categories: { controlled: {} },
	resources: {
		HEART_STUDY: { baseTier: 'open', name: 'Heart study' },
		MEMBERS_ARCHIVE: { baseTier: 'registered', name: 'Members archive' },
		OPEN_ATLAS: { baseTier: 'open', name: 'Open atlas' },
		SEALED_ARCHIVE: { baseTier: 'grant', name: 'Sealed archive' },
	},
	users: { [CORPUS_ANA_USER]: { subject: CORPUS_ANA.subject } },
};

const configured = (fixture: PolicyFixture, overrides: Partial<ControllerConfiguration>): ConformanceConfiguration =>
	Object.freeze({
		applications: Object.values(CONFORMANCE_APPLICATIONS),
		configuration: {
			autoAccept: false,
			baseline: READ,
			issuer: CONFORMANCE_ISSUER,
			signedInRule: READ,
			...overrides,
		},
		fixture,
	});

/**
 * The configurations the corpus was computed against, as #215's plan defines them, each as a harness's
 * applications, configuration and policy: give one to `startHarness`, a case's grants added to its
 * fixture. Global categories are `controlled` and `community-governed` in the first table and
 * `controlled` alone in the signed-in rule's; a global category applies to every resource (O16), so no
 * resource offers one in the store.
 *
 * - `A`: HEART_STUDY, LUNG_COHORT and REEF_ARCHIVE open, VOID_INDEX by grant, all four served by
 *   `arranger-prod`; the baseline on. `STUDY-A1`, by grant, is served by `lyric-example` alone
 *   (case 18). The same for every A.
 * - `A-off`: A with the baseline off.
 * - `A-auto`: A with auto-accept on.
 * - `A'`: A with HEART_STUDY by grant.
 * - `B`, the signed-in rule's: OPEN_ATLAS open, MEMBERS_ARCHIVE registered, SEALED_ARCHIVE by grant,
 *   HEART_STUDY open, all four served by `arranger-prod`; the baseline and the signed-in rule on.
 * - `B-off`: B with the baseline off.
 *
 * The baseline and the signed-in rule grant read, which is count, view and export (#215 Q2), and are
 * configuration (B4); Ana is seeded in each, as {@link CORPUS_ANA_USER}.
 */
export const CONFORMANCE_CONFIGURATIONS: Readonly<Record<ConformanceConfigurationName, ConformanceConfiguration>> =
	Object.freeze({
		"A'": configured(firstTable('grant'), {}),
		A: configured(firstTable('open'), {}),
		'A-auto': configured(firstTable('open'), { autoAccept: true }),
		'A-off': configured(firstTable('open'), { baseline: [] }),
		B: configured(SIGNED_IN_TABLE, {}),
		'B-off': configured(SIGNED_IN_TABLE, { baseline: [] }),
	});
