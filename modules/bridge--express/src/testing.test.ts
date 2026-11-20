import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { suite, test } from 'node:test';

import {
	type CategoryCondition,
	type Enforcement,
	type PermissionsPayload,
	type RecordKeyRegistration,
	validatePayload,
} from '@overture-stack/usher-types';

import type { BridgeConfiguration } from './core/configuration.js';
import type { ChannelCore } from './core/channel.js';
import {
	type BridgeCore,
	type ChannelContext,
	createBridgeCoreWithSeams,
	type ExchangeAnswer,
	type ResolveOutcome,
	type TokenReading,
} from './core/core.js';
import { anonymousAccess, openTierAccess, signedInAccess } from './testing.js';

const corpus = JSON.parse(
	readFileSync(new URL('../../../.dev/design/conformance/principals.json', import.meta.url), 'utf8'),
) as { principals: readonly { case: string; payload: unknown }[] };

const payloadFor = (caseNumber: string, sub?: string): PermissionsPayload => {
	const entry = corpus.principals.find((principal) => principal.case === caseNumber);
	const result = validatePayload(entry?.payload);
	assert.ok(result.success, `case ${caseNumber} is a valid payload`);
	return sub === undefined ? result.payload : { ...result.payload, sub };
};

const ANONYMOUS = payloadFor('02');
const ISSUED_AT_MS = ANONYMOUS.iat * 1000;
const KEY = Buffer.alloc(32, 7).toString('base64url');

const inCondition = (fieldName: string, value: readonly string[]): CategoryCondition => ({
	content: { fieldName, value: [...value] },
	op: 'in',
});

const catalogue: RecordKeyRegistration = {
	categories: {
		global: {
			'global.community-governed': inCondition('data_category', ['community-governed']),
			'global.controlled': inCondition('data_category', ['controlled']),
		},
	},
	kind: 'record',
	resourceFieldName: 'study_id',
};

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A three-part signed sign-in token with a placeholder signature, since only the Controller checks signatures. */
const signInToken = (claims: { sub: string }): string => `${segment({ alg: 'RS256' })}.${segment(claims)}.c2lnbmF0dXJl`;

/** The results of an access outcome, failing the test when the outcome is not an access. */
const resultsOf = (outcome: ResolveOutcome): Readonly<Record<string, Enforcement>> => {
	assert.equal(outcome.kind, 'access', `expected access, got ${outcome.kind}`);
	return outcome.kind === 'access' ? outcome.access.results : assert.fail('unreachable');
};

/**
 * A core in normal mode, driven the way the core's own suites drive it, with the Controller's answers
 * scripted per credential.
 */
const running = async () => {
	const clocks = { monotonic: 0, wall: ISSUED_AT_MS };
	const answers = new Map<string | null, ExchangeAnswer>([[null, { kind: 'token', token: 'token:anonymous' }]]);
	const readings = new Map<string, TokenReading>([['token:anonymous', { kind: 'payload', payload: ANONYMOUS }]]);
	const channel: { core: ChannelCore | undefined } = { core: undefined };

	const configuration: BridgeConfiguration = {
		audience: `audience-${Math.random()}`,
		controllerUrl: 'https://usher.example.org/',
		eventSource: 'https://search.example.org/usher-bridge',
		issuer: 'https://usher.example.org',
		key: KEY,
		logger: { error: () => undefined, info: () => undefined, warn: () => undefined },
		monotonicClock: { now: () => clocks.monotonic },
		payloadVersions: [1],
		wallClock: { now: () => clocks.wall },
	};

	const seams = {
		createChannel: (context: ChannelContext) => {
			channel.core = context.core;
			return { start: () => undefined, stop: () => Promise.resolve() };
		},
		createControllerClient: () => ({
			exchange: ({ credential }: { credential: string | null }): Promise<ExchangeAnswer> =>
				Promise.resolve(answers.get(credential) ?? { kind: 'refused' }),
		}),
		createTokenReader: () => ({
			read: (token: string): Promise<TokenReading> =>
				Promise.resolve(readings.get(token) ?? { kind: 'rejected', reason: 'unexpected' }),
		}),
		random: () => 0,
	};

	const core: BridgeCore = createBridgeCoreWithSeams(configuration, seams);
	core.register({ files: catalogue });
	await core.start();
	channel.core?.confirmChannel(0);
	await core.refreshAnonymous();
	assert.equal(core.mode(), 'normal');

	return {
		advanceMonotonic: (ms: number): void => {
			clocks.monotonic += ms;
		},
		answers,
		core,

		/** Scripts the Controller to answer a credential with a token carrying the payload. */
		issue: (credential: string, payload: PermissionsPayload): void => {
			const token = `token:${credential}`;
			answers.set(credential, { kind: 'token', token });
			readings.set(token, { kind: 'payload', payload });
		},
	};
};

/** The same core, moved into uncertain mode the way the core's own suites move it. */
const uncertain = async () => {
	const harness = await running();
	harness.advanceMonotonic(60_001);
	assert.equal(harness.core.mode(), 'uncertain');
	return harness;
};

/** Whether a named-import list holds only type members, as in `{ type A, type B }`. */
const onlyTypeMembers = (namedImports: string): boolean =>
	namedImports
		.slice(1, -1)
		.split(',')
		.every((member) => member.trim().startsWith('type '));

/**
 * The module each import statement that loads at run time names: a side-effect import, a default or
 * namespace import, or a named import with at least one member that is not a type. A statement written
 * `import type`, or naming only type members, loads nothing and is left out.
 */
const valueImportSources = (text: string): readonly string[] => [
	...[...text.matchAll(/^import\s+'(?<source>[^']+)';/gm)].map(({ groups }) => groups?.source ?? ''),
	...[...text.matchAll(/^import\s+(?!type\s)(?<clause>[^'"]*?)\s*from\s+'(?<source>[^']+)';/gm)]
		.filter(({ groups }) => !(groups?.clause?.startsWith('{') === true && onlyTypeMembers(groups.clause.trim())))
		.map(({ groups }) => groups?.source ?? ''),
];

suite('the testing surface', () => {
	test('anonymousAccess answers a request presenting no credential as the core does', async () => {
		const { core } = await running();
		const outcome = await core.resolve(null);

		assert.deepEqual(anonymousAccess(resultsOf(outcome)), outcome);
		await core.stop();
	});

	test('signedInAccess answers a confirmed principal as the core does in normal mode', async () => {
		const harness = await running();
		const credential = signInToken({ sub: 'subject-ana' });
		harness.issue(credential, payloadFor('05', 'subject-ana'));
		const outcome = await harness.core.resolve(credential);

		assert.deepEqual(signedInAccess('subject-ana', resultsOf(outcome)), outcome);
		await harness.core.stop();
	});

	test('openTierAccess answers a credential never exchanged as the core does in uncertain mode', async () => {
		const harness = await uncertain();
		const open = resultsOf(await harness.core.resolve(null));
		const outcome = await harness.core.resolve(signInToken({ sub: 'subject-new' }));

		assert.deepEqual(openTierAccess(signInToken({ sub: 'subject-new' }), open), outcome);
		await harness.core.stop();
	});

	test('openTierAccess with an attribution-only subject answers a cached credential as the core does in uncertain mode', async () => {
		const harness = await running();
		const credential = signInToken({ sub: 'subject-ana' });
		harness.issue(credential, payloadFor('05', 'subject-ana'));
		await harness.core.resolve(credential);
		harness.advanceMonotonic(60_001);
		const open = resultsOf(await harness.core.resolve(null));
		const outcome = await harness.core.resolve(credential);

		assert.deepEqual(openTierAccess(credential, open, { attributionOnlySubject: 'subject-ana' }), outcome);
		await harness.core.stop();
	});

	test('openTierAccess answers a credential whose exchange failed as the core does', async () => {
		const harness = await running();
		const credential = signInToken({ sub: 'subject-ana' });
		harness.answers.set(credential, { cause: 'timeout', kind: 'failed' });
		const open = resultsOf(await harness.core.resolve(null));
		const outcome = await harness.core.resolve(credential);

		assert.deepEqual(openTierAccess(credential, open), outcome);
		await harness.core.stop();
	});

	test('openTierAccess answers a null credential as the core does in uncertain mode', async () => {
		const harness = await uncertain();
		const outcome = await harness.core.resolve(null);

		assert.deepEqual(openTierAccess(null, resultsOf(outcome)), outcome);
		assert.deepEqual(anonymousAccess(resultsOf(outcome)), outcome);
		await harness.core.stop();
	});

	test("freezes the access it answers and leaves the caller's results as they were", () => {
		const results: Readonly<Record<string, Enforcement>> = {
			records: { kind: 'deny', reason: 'no-grants' },
		};
		const given = structuredClone(results);
		const outcomes = [
			anonymousAccess(given),
			signedInAccess('subject-ana', given),
			openTierAccess('credential', given),
		];

		assert.equal(Object.isFrozen(given), false);
		assert.equal(Object.isFrozen(given.records), false);
		assert.deepEqual(given, results);
		outcomes.forEach((outcome) => {
			assert.equal(outcome.kind === 'access' && Object.isFrozen(outcome.access.results), true);
		});
	});

	test('imports nothing but the core access builders and types, so it touches no running core', async () => {
		const valueImports = valueImportSources(await readFile(new URL('./testing.ts', import.meta.url), 'utf8'));

		assert.deepEqual(valueImports, ['./core/access.js']);
	});
});
