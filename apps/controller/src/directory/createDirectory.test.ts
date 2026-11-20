import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test, type TestContext } from 'node:test';

import type { LineFields } from '../eventLog/index.js';
import { createDirectory, DIRECTORY_BOUNDS, DIRECTORY_UNAVAILABLE } from './createDirectory.js';
import type { Directory, DirectoryBounds } from './types.js';

const REALM = 'overture realm';

const CLIENT_ID = 'usher-directory';

// A secret holding characters a form and a URL escape.
const CLIENT_SECRET = `${randomBytes(12).toString('base64url')}+&=% :`;

/** An account as the stand-in holds it, as Keycloak's admin API represents a user. */
interface Account {
	email?: string;
	emailVerified?: boolean;
	enabled?: boolean;
	firstName?: string;
	id: string;
	lastName?: string;
}

/** How the stand-in answers the admin API's requests, beside answering them as a realm does. */
type AdminMode =
	| 'hang'
	| 'malformed'
	| 'notAList'
	| 'oversized'
	| 'redirect'
	| 'refuseEveryToken'
	| 'unavailable'
	| 'withoutId'
	| 'wrongId'
	| { nearMatch: Account };

/** How the stand-in answers a request for a token. */
type TokenMode = 'malformed' | 'realm' | 'refused';

interface Request {
	authorization: string | undefined;
	body: string;
	method: string;
	url: URL;
}

interface StandIn {
	accounts: readonly Account[];
	adminMode: AdminMode | undefined;

	/** The tokens issued that are still taken. */
	live: Set<string>;

	requests: Request[];

	/** The seconds each token it issues lives. */
	tokenLifetimeSeconds: number;

	tokenMode: TokenMode;

	/** Its base URL, with no trailing slash. */
	url: string;
}

interface Line {
	fields: LineFields | undefined;
	message: string;
}

interface Stand {
	clock: { advance(milliseconds: number): void; now(): number };
	directory: Directory;
	lines: Line[];
	standIn: StandIn;
}

const isAddress = (address: unknown): address is AddressInfo =>
	typeof address === 'object' && address !== null && 'port' in address;

const bodyOf = (request: IncomingMessage): Promise<string> =>
	new Promise((resolve) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	});

// The client's id and secret, from HTTP Basic, decoded as a form's values are.
const basicCredentials = (header: string | undefined): { id: string; secret: string } | undefined => {
	const [scheme, encoded] = (header ?? '').split(' ');
	if (scheme === 'Basic' && encoded !== undefined) {
		const [id = '', secret = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
		return { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
	}
	return undefined;
};

const ACCOUNT_PATH = `/admin/realms/${encodeURIComponent(REALM)}/users`;

const TOKEN_PATH = `/realms/${encodeURIComponent(REALM)}/protocol/openid-connect/token`;

// Starts a stand-in for one Keycloak realm on loopback: its token endpoint, and its admin API's
// users by address and by id.
const startStandIn = async (context: TestContext): Promise<StandIn> => {
	const standIn: StandIn = {
		accounts: [],
		adminMode: undefined,
		live: new Set(),
		requests: [],
		tokenLifetimeSeconds: 300,
		tokenMode: 'realm',
		url: '',
	};
	const json = (response: ServerResponse, status: number, body: unknown): void => {
		response.writeHead(status, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	};
	const server = createServer((request, response) => {
		void bodyOf(request).then((body) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			standIn.requests.push({
				authorization: request.headers.authorization,
				body,
				method: request.method ?? '',
				url,
			});
			if (request.method === 'POST' && url.pathname === TOKEN_PATH) {
				const credentials = basicCredentials(request.headers.authorization);
				const form = new URLSearchParams(body);
				if (
					standIn.tokenMode === 'refused' ||
					form.get('grant_type') !== 'client_credentials' ||
					credentials?.id !== CLIENT_ID ||
					credentials.secret !== CLIENT_SECRET
				) {
					json(response, 401, { error: 'unauthorized_client' });
					return;
				}
				const token = randomBytes(16).toString('base64url');
				standIn.live.add(token);
				json(
					response,
					200,
					standIn.tokenMode === 'malformed'
						? { token_type: 'Bearer' }
						: {
								access_token: token,
								expires_in: standIn.tokenLifetimeSeconds,
								token_type: 'Bearer',
							},
				);
				return;
			}
			const [scheme, token = ''] = (request.headers.authorization ?? '').split(' ');
			const mode = standIn.adminMode;
			if (mode === 'hang') {
				return;
			}
			if (scheme !== 'Bearer' || !standIn.live.has(token) || mode === 'refuseEveryToken') {
				json(response, 401, { error: 'HTTP 401 Unauthorized' });
				return;
			}
			if (mode === 'unavailable') {
				json(response, 503, { error: 'unavailable' });
				return;
			}
			if (mode === 'redirect') {
				response.writeHead(302, { location: `${standIn.url}/elsewhere` });
				response.end();
				return;
			}
			if (mode === 'malformed') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end('[{"id": ');
				return;
			}
			if (mode === 'oversized') {
				json(
					response,
					200,
					Array.from({ length: 64 }, (_, index) => ({
						email: 'filler@example.org',
						id: `filler-${index}`.padEnd(256, 'x'),
					})),
				);
				return;
			}
			if (url.pathname === ACCOUNT_PATH) {
				const address = url.searchParams.get('email') ?? '';
				const matching = standIn.accounts.filter(
					(account) => account.email?.toLowerCase() === address.toLowerCase(),
				);
				if (mode === 'notAList') {
					json(response, 200, { users: matching });
					return;
				}
				if (mode === 'withoutId') {
					json(response, 200, [{ email: address, emailVerified: true }]);
					return;
				}
				json(response, 200, [...matching, ...(typeof mode === 'object' ? [mode.nearMatch] : [])]);
				return;
			}
			if (url.pathname.startsWith(`${ACCOUNT_PATH}/`)) {
				const id = decodeURIComponent(url.pathname.slice(ACCOUNT_PATH.length + 1));
				const account = standIn.accounts.find((held) => held.id === id);
				if (account === undefined) {
					json(response, 404, { error: 'User not found' });
					return;
				}
				json(response, 200, mode === 'wrongId' ? { ...account, id: 'another-id' } : account);
				return;
			}
			json(response, 404, { error: 'Unable to find matching target' });
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!isAddress(address)) {
		throw new Error('the stand-in listens on no TCP address');
	}
	standIn.url = `http://127.0.0.1:${address.port}`;
	context.after(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return standIn;
};

const unusedPort = (): Promise<number> =>
	new Promise((resolve) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => resolve(isAddress(address) ? address.port : 0));
		});
	});

const standUp = async (
	context: TestContext,
	{ bounds = DIRECTORY_BOUNDS, url }: { bounds?: DirectoryBounds; url?: string } = {},
): Promise<Stand> => {
	const standIn = await startStandIn(context);
	const state = { now: Date.UTC(2026, 10, 14, 12, 0, 0) };
	const clock = {
		advance: (milliseconds: number) => {
			state.now += milliseconds;
		},
		now: () => state.now,
	};
	const lines: Line[] = [];
	const directory = createDirectory(
		{
			clock,
			directoryClientId: CLIENT_ID,
			directoryClientSecret: CLIENT_SECRET,
			directoryRealm: REALM,
			directoryUrl: url ?? standIn.url,
		},
		{ error: (message, fields) => lines.push({ fields, message }) },
		bounds,
	);
	return { clock, directory, lines, standIn };
};

const SUB_BO: Account = {
	email: 'sub.bo@example.org',
	emailVerified: true,
	enabled: true,
	firstName: 'Bo',
	id: '4f1d2c3b-9a8e-4d7c-b6a5-0e1f2a3b4c5d',
	lastName: 'Lindqvist',
};

const tokenRequests = ({ requests }: StandIn): readonly Request[] =>
	requests.filter(({ url }) => url.pathname === TOKEN_PATH);

const adminRequests = ({ requests }: StandIn): readonly Request[] =>
	requests.filter(({ url }) => url.pathname !== TOKEN_PATH);

// Runs each step after the one before it has settled, giving their results in order.
const inTurn = <Item, Result>(
	items: readonly Item[],
	step: (item: Item) => Promise<Result>,
): Promise<readonly Result[]> =>
	items.reduce<Promise<readonly Result[]>>(
		async (earlier, item) => [...(await earlier), await step(item)],
		Promise.resolve([]),
	);

// Everything a line written shows a reader.
const shownBy = (lines: readonly Line[]): string => JSON.stringify(lines);

suite('resolving an address through the directory', () => {
	test('resolves an address to the id of the one account holding it verified, in any letter case, through the exact search under a client credentials token', async (context) => {
		const { directory, standIn } = await standUp(context);
		standIn.accounts = [SUB_BO];

		const resolved = await directory.resolveAddress('Sub.Bo@Example.ORG');

		assert.deepEqual(resolved, { kind: 'resolved', subject: SUB_BO.id });
		const [token] = tokenRequests(standIn);
		assert.equal(token?.method, 'POST');
		assert.deepEqual(Object.fromEntries(new URLSearchParams(token?.body ?? '')), {
			grant_type: 'client_credentials',
		});
		const [search] = adminRequests(standIn);
		assert.equal(search?.method, 'GET');
		assert.equal(search?.url.pathname, ACCOUNT_PATH);
		assert.deepEqual([...(search?.url.searchParams ?? [])].toSorted(), [
			['email', 'Sub.Bo@Example.ORG'],
			['exact', 'true'],
		]);
		assert.match(search?.authorization ?? '', /^Bearer \S+$/u);
	});

	test('sends every character of an address as given, a search wildcard and a form delimiter among them', async (context) => {
		const { directory, standIn } = await standUp(context);
		const addresses = ['bo+ims@example.org', 'zoë@example.org', 'a&b=c%d#e@example.org', '*@example.org'];
		standIn.accounts = addresses.map((email, index) => ({
			email,
			emailVerified: true,
			id: `account-${index}`,
		}));

		const resolved = await Promise.all(addresses.map((address) => directory.resolveAddress(address)));

		assert.deepEqual(
			resolved,
			addresses.map((_, index) => ({
				kind: 'resolved',
				subject: `account-${index}`,
			})),
		);
		assert.deepEqual(
			adminRequests(standIn)
				.map(({ url }) => url.searchParams.get('email'))
				.toSorted(),
			addresses.toSorted(),
		);
	});

	test('counts a disabled account as holding its address', async (context) => {
		const { directory, standIn } = await standUp(context);
		standIn.accounts = [{ ...SUB_BO, enabled: false }];

		const resolved = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(resolved, { kind: 'resolved', subject: SUB_BO.id });
	});

	test('finds no single account for an address no account holds, one held unverified, one several accounts hold, and a near match the directory returns', async (context) => {
		const { directory, standIn } = await standUp(context);
		standIn.accounts = [
			{ email: 'una@example.org', emailVerified: false, id: 'una' },
			{ email: 'dup@example.org', emailVerified: true, id: 'dup-one' },
			{ email: 'DUP@example.org', emailVerified: true, id: 'dup-two' },
		];

		const answers = await Promise.all(
			['nobody@example.org', 'una@example.org', 'dup@example.org'].map((address) =>
				directory.resolveAddress(address),
			),
		);
		standIn.adminMode = {
			nearMatch: {
				email: 'bo.smith@example.org',
				emailVerified: true,
				id: 'x',
			},
		};
		const nearMatch = await directory.resolveAddress('bo@example.org');

		assert.deepEqual(
			[...answers, nearMatch].map(({ kind }) => kind),
			['unheld', 'unheld', 'unheld', 'unheld'],
		);
	});

	test('takes one token for every lookup until 30 s before it expires on the configured clock, then takes another', async (context) => {
		const { clock, directory, standIn } = await standUp(context);
		standIn.accounts = [SUB_BO];
		const address = SUB_BO.email ?? '';

		await Promise.all([directory.resolveAddress(address), directory.resolveAddress(address)]);
		clock.advance(269_000);
		await directory.resolveAddress(address);
		const beforeRenewal = tokenRequests(standIn).length;
		clock.advance(1000);
		await directory.resolveAddress(address);

		assert.equal(beforeRenewal, 1);
		assert.equal(tokenRequests(standIn).length, 2);
		assert.equal(adminRequests(standIn).length, 4);
	});

	test('takes a fresh token once when the admin API refuses the one held, and answers with it', async (context) => {
		const { directory, standIn } = await standUp(context);
		standIn.accounts = [SUB_BO];
		await directory.resolveAddress(SUB_BO.email ?? '');
		standIn.live.clear();

		const resolved = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(resolved, { kind: 'resolved', subject: SUB_BO.id });
		assert.equal(tokenRequests(standIn).length, 2);
	});

	test('cannot answer while the admin API refuses a fresh token too, asking for one fresh token alone', async (context) => {
		const { directory, lines, standIn } = await standUp(context);
		standIn.adminMode = 'refuseEveryToken';

		const answer = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(answer, { kind: 'unavailable' });
		assert.equal(tokenRequests(standIn).length, 2);
		assert.deepEqual(lines, [
			{
				fields: { cause: 'credentialRefused', lookup: 'address' },
				message: DIRECTORY_UNAVAILABLE,
			},
		]);
	});

	test('cannot answer while its credential is refused, or the token answered is malformed', async (context) => {
		const { directory, lines, standIn } = await standUp(context);

		standIn.tokenMode = 'refused';
		const refused = await directory.resolveAddress(SUB_BO.email ?? '');
		standIn.tokenMode = 'malformed';
		const malformed = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual([refused, malformed], [{ kind: 'unavailable' }, { kind: 'unavailable' }]);
		assert.deepEqual(
			lines.map(({ fields }) => fields?.['cause']),
			['credentialRefused', 'malformedAnswer'],
		);
		assert.deepEqual(adminRequests(standIn), []);
	});

	test('cannot answer an admin API answering 5xx, a redirect, a malformed answer, an answer that is no list, or an account without an id', async (context) => {
		const { directory, lines, standIn } = await standUp(context);
		const modes: readonly AdminMode[] = ['unavailable', 'redirect', 'malformed', 'notAList', 'withoutId'];

		const answers = await inTurn(modes, (mode) => {
			standIn.adminMode = mode;
			return directory.resolveAddress(SUB_BO.email ?? '');
		});

		assert.deepEqual(
			answers.map(({ kind }) => kind),
			modes.map(() => 'unavailable'),
		);
		assert.deepEqual(
			lines.map(({ fields }) => fields),
			[
				{ cause: 'status', lookup: 'address', status: 503 },
				{ cause: 'status', lookup: 'address', status: 302 },
				{ cause: 'malformedAnswer', lookup: 'address' },
				{ cause: 'malformedAnswer', lookup: 'address' },
				{ cause: 'malformedAnswer', lookup: 'address' },
			],
		);
	});

	test('cannot answer an answer larger than its bound, reading no more of it', async (context) => {
		const { directory, lines, standIn } = await standUp(context, {
			bounds: { ...DIRECTORY_BOUNDS, answerLimitBytes: 4096 },
		});
		standIn.adminMode = 'oversized';

		const answer = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(answer, { kind: 'unavailable' });
		assert.deepEqual(
			lines.map(({ fields }) => fields?.['cause']),
			['answerTooLarge'],
		);
	});

	test('cannot answer once its deadline passes with no answer', async (context) => {
		const { directory, lines, standIn } = await standUp(context, {
			bounds: { ...DIRECTORY_BOUNDS, deadlineMilliseconds: 200 },
		});
		standIn.adminMode = 'hang';
		const started = performance.now();

		const answer = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(answer, { kind: 'unavailable' });
		assert.ok(performance.now() - started < 2000);
		assert.deepEqual(
			lines.map(({ fields }) => fields?.['cause']),
			['timeout'],
		);
	});

	test('cannot answer while nothing listens at its URL', async (context) => {
		const { directory, lines } = await standUp(context, {
			url: `http://127.0.0.1:${await unusedPort()}`,
		});

		const answer = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(answer, { kind: 'unavailable' });
		assert.deepEqual(
			lines.map(({ fields }) => fields?.['cause']),
			['unreachable'],
		);
	});

	test('names in its lines no secret, token, address, host or port', async (context) => {
		const { directory, lines, standIn } = await standUp(context);
		standIn.adminMode = 'refuseEveryToken';
		await directory.resolveAddress(SUB_BO.email ?? '');
		standIn.adminMode = 'unavailable';
		await directory.resolveAddress(SUB_BO.email ?? '');
		standIn.tokenMode = 'refused';
		await directory.resolveAddress(SUB_BO.email ?? '');
		const port = new URL(standIn.url).port;

		const shown = shownBy(lines);

		assert.equal(lines.length, 3);
		[
			CLIENT_SECRET,
			encodeURIComponent(CLIENT_SECRET),
			...standIn.live,
			SUB_BO.email ?? '',
			'127.0.0.1',
			port,
			REALM,
		].forEach((withheld) => {
			assert.equal(shown.includes(withheld), false, withheld);
		});
	});

	test('answers that it holds no directory when its URL is empty, asking nothing', async (context) => {
		const { directory, lines, standIn } = await standUp(context, { url: '' });

		const answer = await directory.resolveAddress(SUB_BO.email ?? '');

		assert.deepEqual(answer, { kind: 'unconfigured' });
		assert.deepEqual(standIn.requests, []);
		assert.deepEqual(lines, []);
	});
});

suite('reading an account through the directory', () => {
	test("gives the account's given and family names and its address, by its id", async (context) => {
		const { directory, standIn } = await standUp(context);
		standIn.accounts = [SUB_BO, { id: 'auth0|bo+test/=' }];

		const held = await directory.accountOf(SUB_BO.id);
		const bare = await directory.accountOf('auth0|bo+test/=');

		assert.deepEqual(held, {
			account: {
				email: SUB_BO.email,
				familyName: SUB_BO.lastName,
				givenName: SUB_BO.firstName,
			},
			kind: 'held',
		});
		assert.deepEqual(bare, {
			account: { email: null, familyName: null, givenName: null },
			kind: 'held',
		});
		assert.deepEqual(
			adminRequests(standIn).map(({ url }) => url.pathname),
			[`${ACCOUNT_PATH}/${SUB_BO.id}`, `${ACCOUNT_PATH}/${encodeURIComponent('auth0|bo+test/=')}`],
		);
	});

	test('answers an id no account holds as an account no longer held, asking nothing for one naming no single path segment', async (context) => {
		const { directory, standIn } = await standUp(context);

		const answers = await Promise.all(
			['gone-account', '', '.', '..'].map((subject) => directory.accountOf(subject)),
		);

		assert.deepEqual(
			answers.map(({ kind }) => kind),
			['absent', 'absent', 'absent', 'absent'],
		);
		assert.deepEqual(
			adminRequests(standIn).map(({ url }) => url.pathname),
			[`${ACCOUNT_PATH}/gone-account`],
		);
	});

	test('cannot answer a 5xx, or an account naming another id', async (context) => {
		const { directory, lines, standIn } = await standUp(context);
		standIn.accounts = [SUB_BO];

		standIn.adminMode = 'unavailable';
		const failing = await directory.accountOf(SUB_BO.id);
		standIn.adminMode = 'wrongId';
		const another = await directory.accountOf(SUB_BO.id);

		assert.deepEqual([failing, another], [{ kind: 'unavailable' }, { kind: 'unavailable' }]);
		assert.deepEqual(
			lines.map(({ fields }) => fields),
			[
				{ cause: 'status', lookup: 'account', status: 503 },
				{ cause: 'malformedAnswer', lookup: 'account' },
			],
		);
	});

	test('answers that it holds no directory when its URL is empty', async (context) => {
		const { directory, standIn } = await standUp(context, { url: '' });

		const answer = await directory.accountOf(SUB_BO.id);

		assert.deepEqual(answer, { kind: 'unconfigured' });
		assert.deepEqual(standIn.requests, []);
	});
});
