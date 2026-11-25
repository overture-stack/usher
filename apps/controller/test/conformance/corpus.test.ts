import assert from 'node:assert/strict';
import { suite, type TestContext, test } from 'node:test';

import {
	administratorCaller,
	assertSucceeded,
	IDENTITY_REVOCATION_REASONS,
	liftIdentityRevocation,
	revokeIdentity,
} from '../../testing/harness/admin.js';
import {
	assertConformsToCorpus,
	comparablePayload,
	type ConformanceConfigurationName,
	CORPUS_ANA,
	CORPUS_ANA_USER,
	CORPUS_CASES,
	readCorpusEntry,
	readCorpusIndex,
} from '../../testing/fixtures/conformanceCorpus.js';
import { suiteFlushedCache } from '../../testing/harness/containers.js';
import { carriesToken, exchange, PEOPLE, type Person } from '../../testing/harness/exchange.js';
import {
	type AnaGrant,
	answerAsAna,
	ARRANGER_PROD,
	ARTIFACT_ROLE,
	ARTIFACT_ROLE_POLICY,
	changeRoleAsOwner,
	conformanceHarnessOptions,
	grantToAna,
	groupGrantPolicy,
	LYRIC_EXAMPLE,
	replayedPayload,
	revokeAsOwner,
	ROLE_CAPABILITIES,
} from '../../testing/fixtures/conformance.js';
import { actionsHeld, CATEGORY, CURATOR_ACTIONS } from '../../testing/fixtures/issuance.js';
import { type Harness, withHarness } from '../../testing/harness/harness.js';
import { inTurn, type PolicyFixture, removeGroupMember, seededId } from '../../testing/harness/policy.js';
import { eventually, nowSeconds, suiteCleanup } from '../../testing/harness/waiting.js';

// A near expiry for case 11: long enough to create, accept and exchange before it passes,
// and the wait for it bounded by it and a margin for the expiry's whole-second rounding.
const NEAR_EXPIRY_MS = 10_000;

const EXPIRY_MARGIN_MS = 5_000;

// No payload for a token the Bridge refuses as expired on arrival; any other failure is rethrown.
const unlessExpiredOnArrival = (failure: unknown): undefined => {
	if (failure instanceof Error && failure.message.endsWith(': expired')) {
		return undefined;
	}
	throw failure;
};

const HEART_CONTROLLED_CURATOR = Object.freeze({
	category: 'controlled',
	resource: 'HEART_STUDY',
	role: 'curator',
});

/** One replayed case: its test's name, the policy it seeds by SQL, and what it does and asserts. */
interface CorpusReplay {
	name: string;
	policy?: PolicyFixture;

	/** The case's inputs through the API or by SQL, the exchange, and the comparison with the corpus. */
	run(harness: Harness, caseNumber: string): Promise<void>;
}

const conformsFor =
	(person: Person | null): CorpusReplay['run'] =>
	async (harness, caseNumber) => {
		const issued = await replayedPayload(harness, { person });

		// Read from the conformance corpus.
		assertConformsToCorpus(issued, readCorpusEntry(caseNumber), harness);
	};

const keptOutOfAnaHeldByBo: CorpusReplay['run'] = async (harness, caseNumber) => {
	const hers = await replayedPayload(harness, { person: CORPUS_ANA });
	const accepted = await replayedPayload(harness, { person: PEOPLE.bo });

	// Read from the conformance corpus.
	assertConformsToCorpus(hers, readCorpusEntry(caseNumber), harness);
	assert.deepEqual(actionsHeld(accepted, 'HEART_STUDY', CATEGORY.controlled), CURATOR_ACTIONS);
};

const grantedAndAnswered = async (
	harness: Harness,
	grant: AnaGrant,
	capabilities: readonly string[],
): Promise<string> => {
	const grantId = await grantToAna(harness, grant);
	await answerAsAna(harness, grantId, 'accept', capabilities);
	return grantId;
};

const REPLAYS: Readonly<Record<string, CorpusReplay>> = {
	'01': {
		name: 'issues an anonymous visitor an empty permissions map while the baseline is off',
		run: conformsFor(null),
	},
	'02': {
		name: 'grants an anonymous visitor read on the unmarked records of each open resource',
		run: conformsFor(null),
	},
	'03': {
		name: 'issues a signed-in principal holding nothing the anonymous contents with her subject',
		run: conformsFor(CORPUS_ANA),
	},
	'04': {
		name: 'keeps out a grant she has not decided on',
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			controlMember: true,
			group: 'G1',
		}),
		run: keptOutOfAnaHeldByBo,
	},
	'05': {
		name: "confers curator's record actions on HEART_STUDY/controlled once she accepts",
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			decision: 'accepted',
			group: 'G1',
		}),
		run: conformsFor(CORPUS_ANA),
	},
	'06': {
		name: 'keeps out a grant she rejected, its payload equal to the undecided one',
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			controlMember: true,
			decision: 'declined',
			group: 'G1',
		}),
		run: async (harness, caseNumber) => {
			await keptOutOfAnaHeldByBo(harness, caseNumber);

			// Read from the conformance corpus: the case's entry and case 04's, the undecided grant.
			const rejected = readCorpusEntry(caseNumber);
			const undecided = readCorpusEntry('04');
			assertConformsToCorpus(await replayedPayload(harness, { person: CORPUS_ANA }), undecided, harness);
			assert.deepEqual(comparablePayload(rejected.payload), comparablePayload(undecided.payload));
		},
	},
	'07': {
		name: 'holds two grants on one resource at their own roles',
		policy: groupGrantPolicy(
			{ ...HEART_CONTROLLED_CURATOR, decision: 'accepted', group: 'G1' },
			{
				category: 'unmarked',
				decision: 'accepted',
				group: 'G2',
				resource: 'HEART_STUDY',
				role: 'viewer',
			},
		),
		run: conformsFor(CORPUS_ANA),
	},
	'08': {
		name: 'unions two identical accepted grants into one entry',
		policy: groupGrantPolicy(
			{ ...HEART_CONTROLLED_CURATOR, decision: 'accepted', group: 'G1' },
			{ ...HEART_CONTROLLED_CURATOR, decision: 'accepted', group: 'G2' },
		),
		run: conformsFor(CORPUS_ANA),
	},
	'09': {
		name: "reaches REEF_ARCHIVE's controlled records and leaves community-governed unreached",
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			decision: 'accepted',
			group: 'G1',
			resource: 'REEF_ARCHIVE',
		}),
		run: conformsFor(CORPUS_ANA),
	},
	'10': {
		name: 'leaves a by-grant resource nobody holds out of permissions and lists it as served',
		run: conformsFor(CORPUS_ANA),
	},
	'11': {
		name: 'keeps out an accepted grant once it expires',
		run: async (harness, caseNumber) => {
			const expiresAt = new Date(Date.now() + NEAR_EXPIRY_MS).toISOString();
			await grantedAndAnswered(harness, { ...HEART_CONTROLLED_CURATOR, expiresAt }, ROLE_CAPABILITIES.curator);
			const beforeExpiry = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			// A token issued in the grant's last second expires on arrival, so it is read again.
			const lapsed = await eventually(
				async () => {
					const payload = await replayedPayload(harness, { person: CORPUS_ANA }).catch(
						unlessExpiredOnArrival,
					);
					return (
						payload !== undefined && actionsHeld(payload, 'HEART_STUDY', CATEGORY.controlled) === undefined
					);
				},
				NEAR_EXPIRY_MS + EXPIRY_MARGIN_MS,
				250,
			);
			const afterExpiry = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			// Read from the conformance corpus: case 05's entry, holding the grant, and the case's own.
			assertConformsToCorpus(beforeExpiry, readCorpusEntry('05'), harness);
			assert.ok(lapsed, 'the grant was still conferred past its expiry');
			assertConformsToCorpus(afterExpiry, readCorpusEntry(caseNumber), harness);
		},
	},
	'12': {
		name: 'keeps out an accepted grant once revoked',
		run: async (harness, caseNumber) => {
			const grantId = await grantedAndAnswered(harness, HEART_CONTROLLED_CURATOR, ROLE_CAPABILITIES.curator);
			const beforeRevocation = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await revokeAsOwner(harness, grantId);
			const afterRevocation = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			// Read from the conformance corpus: case 05's entry, holding the grant, and the case's own.
			assertConformsToCorpus(beforeRevocation, readCorpusEntry('05'), harness);
			assertConformsToCorpus(afterRevocation, readCorpusEntry(caseNumber), harness);
		},
	},
	'13': {
		name: 'stands by her later decision',
		run: async (harness, caseNumber) => {
			const grantId = await grantToAna(harness, HEART_CONTROLLED_CURATOR);
			await answerAsAna(harness, grantId, 'decline', ROLE_CAPABILITIES.curator);
			const afterDecline = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await answerAsAna(harness, grantId, 'accept', ROLE_CAPABILITIES.curator);
			const afterAcceptance = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			// Read from the conformance corpus: case 06's entry, the rejection, and the case's own.
			assertConformsToCorpus(afterDecline, readCorpusEntry('06'), harness);
			assertConformsToCorpus(afterAcceptance, readCorpusEntry(caseNumber), harness);
		},
	},
	'14': {
		name: "narrows an accepted grant to its new role's actions",
		run: async (harness, caseNumber) => {
			const grantId = await grantedAndAnswered(harness, HEART_CONTROLLED_CURATOR, ROLE_CAPABILITIES.curator);
			const atCurator = await replayedPayload(harness, { person: CORPUS_ANA });

			await changeRoleAsOwner(harness, grantId, 'viewer');
			const atViewer = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 05's entry, at curator, and the case's own.
			assertConformsToCorpus(atCurator, readCorpusEntry('05'), harness);
			assertConformsToCorpus(atViewer, readCorpusEntry(caseNumber), harness);
		},
	},
	'15': {
		name: "confers no action she has not accepted when her grant's role widens",
		run: async (harness, caseNumber) => {
			const grantId = await grantedAndAnswered(
				harness,
				{ ...HEART_CONTROLLED_CURATOR, role: 'viewer' },
				ROLE_CAPABILITIES.viewer,
			);
			const atViewer = await replayedPayload(harness, { person: CORPUS_ANA });

			await changeRoleAsOwner(harness, grantId, 'curator');
			const widened = await replayedPayload(harness, { person: CORPUS_ANA });
			await answerAsAna(harness, grantId, 'accept', ROLE_CAPABILITIES.curator);
			const acceptedAgain = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			// Read from the conformance corpus: the case's entry before and after the widening, and case
			// 05's once she accepts what the wider role carries.
			const entry = readCorpusEntry(caseNumber);
			assertConformsToCorpus(atViewer, entry, harness);
			assertConformsToCorpus(widened, entry, harness);
			assertConformsToCorpus(acceptedAgain, readCorpusEntry('05'), harness);
		},
	},
	'16': {
		name: "keeps out a group's grant once she leaves the group",
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			decision: 'accepted',
			group: 'G1',
		}),
		run: async (harness, caseNumber) => {
			const inGroup = await replayedPayload(harness, { person: CORPUS_ANA });

			await removeGroupMember(harness.clients.migration, {
				groupId: seededId(harness.seeded.groups, 'G1'),
				userId: seededId(harness.seeded.users, CORPUS_ANA_USER),
			});
			const leftGroup = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 05's entry, in the group, and the case's own.
			assertConformsToCorpus(inGroup, readCorpusEntry('05'), harness);
			assertConformsToCorpus(leftGroup, readCorpusEntry(caseNumber), harness);
		},
	},
	'18': {
		name: 'leaves out a grant on a resource its audience does not serve',
		run: async (harness, caseNumber) => {
			await grantedAndAnswered(
				harness,
				{ category: 'unmarked', resource: 'STUDY-A1', role: 'curator' },
				ROLE_CAPABILITIES.curator,
			);

			const forArranger = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});
			const forLyric = await replayedPayload(harness, {
				application: LYRIC_EXAMPLE,
				person: CORPUS_ANA,
			});

			// Read from the conformance corpus.
			assertConformsToCorpus(forArranger, readCorpusEntry(caseNumber), harness);
			assert.deepEqual(actionsHeld(forLyric, 'STUDY-A1', CATEGORY.unmarked), CURATOR_ACTIONS);
		},
	},
	'19': {
		name: 'leaves out a by-grant resource she holds nothing on',
		run: conformsFor(CORPUS_ANA),
	},
	'19b': {
		name: "reaches a by-grant resource's unmarked records through a grant on unmarked",
		run: async (harness, caseNumber) => {
			const holdingNothing = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await grantedAndAnswered(
				harness,
				{ category: 'unmarked', resource: 'HEART_STUDY', role: 'viewer' },
				ROLE_CAPABILITIES.viewer,
			);
			const granted = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 19's entry, holding nothing, and the case's own.
			assertConformsToCorpus(holdingNothing, readCorpusEntry('19'), harness);
			assertConformsToCorpus(granted, readCorpusEntry(caseNumber), harness);
		},
	},
	'20': {
		name: "records an accepted decision at a grant's creation while auto-accept is on",
		run: async (harness, caseNumber) => {
			const beforeGrant = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await grantToAna(harness, HEART_CONTROLLED_CURATOR);
			const granted = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 03's entry, holding nothing, and the case's own.
			assertConformsToCorpus(beforeGrant, readCorpusEntry('03'), harness);
			assertConformsToCorpus(granted, readCorpusEntry(caseNumber), harness);
		},
	},
	'22': {
		name: "issues the payload case 22's records are judged against",
		policy: groupGrantPolicy({
			...HEART_CONTROLLED_CURATOR,
			decision: 'accepted',
			group: 'G1',
			resource: 'REEF_ARCHIVE',
		}),
		run: conformsFor(CORPUS_ANA),
	},
	'23': {
		name: "issues the payload case 23's records are judged against",
		run: conformsFor(CORPUS_ANA),
	},
	'24c': {
		name: 'emits no field key for a category not partitioned by field',
		run: conformsFor(CORPUS_ANA),
	},
	'27': {
		name: 'confers artifact.create where her role carries it',
		policy: ARTIFACT_ROLE_POLICY,
		run: async (harness, caseNumber) => {
			await grantedAndAnswered(
				harness,
				{ category: 'unmarked', resource: 'HEART_STUDY', role: ARTIFACT_ROLE },
				ROLE_CAPABILITIES.artifactCreator,
			);

			const granted = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus.
			assertConformsToCorpus(granted, readCorpusEntry(caseNumber), harness);
		},
	},
	'28': {
		name: "grants an anonymous visitor the open resources under the signed-in rule's configuration",
		run: conformsFor(null),
	},
	'29': {
		name: 'issues an anonymous visitor an empty map under the signed-in rule with the baseline off',
		run: conformsFor(null),
	},
	'30': {
		name: "adds the signed-in rule's grant on a registered resource for a signed-in principal",
		run: conformsFor(CORPUS_ANA),
	},
	'31': {
		name: 'grants a signed-in principal the registered resource alone while the baseline is off',
		run: conformsFor(CORPUS_ANA),
	},
	'32': {
		name: "accumulates the signed-in rule's grants and her own",
		run: async (harness, caseNumber) => {
			const holdingNothing = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await grantedAndAnswered(
				harness,
				{ ...HEART_CONTROLLED_CURATOR, role: 'viewer' },
				ROLE_CAPABILITIES.viewer,
			);
			const granted = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 30's entry, holding nothing, and the case's own.
			assertConformsToCorpus(holdingNothing, readCorpusEntry('30'), harness);
			assertConformsToCorpus(granted, readCorpusEntry(caseNumber), harness);
		},
	},
	'35': {
		name: "reaches a by-grant resource's unmarked records once granted under the signed-in rule",
		run: async (harness, caseNumber) => {
			const holdingNothing = await replayedPayload(harness, {
				person: CORPUS_ANA,
			});

			await grantedAndAnswered(
				harness,
				{ category: 'unmarked', resource: 'SEALED_ARCHIVE', role: 'viewer' },
				ROLE_CAPABILITIES.viewer,
			);
			const granted = await replayedPayload(harness, { person: CORPUS_ANA });

			// Read from the conformance corpus: case 30's entry, holding nothing, and the case's own.
			assertConformsToCorpus(holdingNothing, readCorpusEntry('30'), harness);
			assertConformsToCorpus(granted, readCorpusEntry(caseNumber), harness);
		},
	},
};

const sorted = (values: Iterable<string>): readonly string[] => [...values].toSorted();

const SIGNED_IN_RULE_CONFIGURATIONS: ReadonlySet<ConformanceConfigurationName> = new Set(['B', 'B-off']);

suite('the conformance corpus, replayed against the Controller', () => {
	const flushedCache = suiteFlushedCache(suiteCleanup());

	const withCorpusHarness = async (
		context: TestContext,
		configuration: ConformanceConfigurationName,
		policy: PolicyFixture,
		work: (harness: Harness) => Promise<void>,
	): Promise<void> => {
		const cacheUrl = await flushedCache();
		await withHarness(conformanceHarnessOptions(configuration, { cacheUrl, policy }), work, context);
	};

	test('replays or lists every principals.json entry, each exactly once', async (context) => {
		// Read once a Controller runs, as every test of this suite reads the corpus, so that none
		// passes before the Controller exists.
		await withCorpusHarness(context, 'A', {}, async () => {
			// Read from the conformance corpus: every case it names, and each entry.
			const index = readCorpusIndex();
			const entries = index.entries.map((caseNumber) => readCorpusEntry(caseNumber));

			const replayed = Object.keys(CORPUS_CASES.replayed);
			const unreachable = Object.keys(CORPUS_CASES.unreachable);
			index.entries.forEach((caseNumber) => {
				assert.equal(
					[replayed, unreachable].filter((table) => table.includes(caseNumber)).length,
					1,
					`case ${caseNumber} is replayed or listed unreachable, and not both`,
				);
			});
			assert.equal(new Set(index.entries).size, index.entries.length);
			assert.deepEqual(sorted([...replayed, ...unreachable]), sorted(index.entries));
			assert.deepEqual(sorted(Object.keys(CORPUS_CASES.omitted)), sorted(index.omitted));
			assert.deepEqual(sorted(Object.keys(REPLAYS)), sorted(replayed));
			entries.forEach((entry) => {
				const configuration = Object.hasOwn(CORPUS_CASES.replayed, entry.case)
					? CORPUS_CASES.replayed[entry.case]
					: undefined;
				if (entry.implementable === false) {
					assert.ok(
						unreachable.includes(entry.case),
						`case ${entry.case}, marked not implementable, is listed unreachable`,
					);
				}
				if (configuration !== undefined) {
					assert.equal(
						SIGNED_IN_RULE_CONFIGURATIONS.has(configuration),
						entry.configuration === 'signed-in rule',
						`case ${entry.case} runs under the configuration its entry was computed against`,
					);
				}
			});
		});
	});

	Object.entries(CORPUS_CASES.replayed).forEach(([caseNumber, configuration]) => {
		const replay = Object.hasOwn(REPLAYS, caseNumber) ? REPLAYS[caseNumber] : undefined;
		if (replay === undefined) {
			return;
		}
		test(replay.name, async (context) => {
			await withCorpusHarness(context, configuration, replay.policy ?? {}, (harness) =>
				replay.run(harness, caseNumber),
			);
		});
	});

	test('answers 403 to a principal whose identity is revoked, and her payload once it is lifted', async (context) => {
		await withCorpusHarness(context, 'B', {}, async (harness) => {
			const administrator = await administratorCaller(harness);
			assertSucceeded(
				await revokeIdentity(administrator, {
					reason: IDENTITY_REVOCATION_REASONS.securityIncident,
					subject: CORPUS_ANA.subject,
				}),
				"revoking Ana's identity",
			);

			const whileRevoked = await exchange(harness.url, {
				application: harness.application(ARRANGER_PROD),
				credential: await harness.tokens.signIn(CORPUS_ANA),
			});
			assertSucceeded(await liftIdentityRevocation(administrator, CORPUS_ANA.subject), 'lifting the revocation');
			// A lift accepts only a sign-in issued after its second.
			const liftedIn = nowSeconds();
			await eventually(async () => nowSeconds() > liftedIn, 2_000, 50);
			const lifted = await replayedPayload(harness, { person: CORPUS_ANA });

			assert.equal(whileRevoked.status, 403);
			assert.equal(carriesToken(whileRevoked.body), false);
			// Read from the conformance corpus: case 30's entry, her payload under the signed-in rule.
			assertConformsToCorpus(lifted, readCorpusEntry('30'), harness);
		});
	});

	test('answers 403 to a sign-in token past its exp', async (context) => {
		await withCorpusHarness(context, 'B', {}, async (harness) => {
			const now = nowSeconds();
			const expired = await harness.tokens.signIn(CORPUS_ANA, {
				mint: { claims: { exp: now - 60, iat: now - 360 } },
			});

			const refused = await exchange(harness.url, {
				application: harness.application(ARRANGER_PROD),
				credential: expired,
			});
			const current = await replayedPayload(harness, { person: CORPUS_ANA });

			assert.equal(refused.status, 403);
			assert.equal(carriesToken(refused.body), false);
			// Read from the conformance corpus: case 30's entry, her payload for a current sign-in token.
			assertConformsToCorpus(current, readCorpusEntry('30'), harness);
		});
	});

	test('stamps every replayed token with a current iat, an exp after it within the token lifetime, and generatedAt no later than iat', async () => {
		const configurations = [...new Set(Object.values(CORPUS_CASES.replayed))];

		const stamped = await inTurn(configurations, async (configuration) => {
			const cacheUrl = await flushedCache();
			return withHarness(conformanceHarnessOptions(configuration, { cacheUrl }), async (harness) =>
				inTurn([null, CORPUS_ANA], async (person) => {
					const startedAt = nowSeconds();
					const { exp, generatedAt, iat } = await replayedPayload(harness, {
						person,
					});
					return {
						endedAt: nowSeconds(),
						exp,
						generatedAt,
						iat,
						lifetime: harness.configuration.tokenLifetimeSeconds,
						name: `${configuration}, ${person === null ? 'anonymous' : 'Ana'}`,
						startedAt,
					};
				}),
			);
		});

		assert.equal(stamped.flat().length, 2 * configurations.length);
		stamped.flat().forEach(({ endedAt, exp, generatedAt, iat, lifetime, name, startedAt }) => {
			assert.ok(iat >= startedAt && iat <= endedAt, `${name}: iat`);
			assert.ok(exp > iat && exp - iat <= lifetime, `${name}: exp`);
			assert.ok(generatedAt <= iat, `${name}: generatedAt`);
		});
	});
});
