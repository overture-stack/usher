import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { suite, test } from 'node:test';

import fastCheck from 'fast-check';

import { createFetchControllerClient, retryAfterSecondsOf } from './controllerClient.js';
import type { ExchangeAnswer } from './core.js';

interface Received {
	body: string;
	headers: IncomingHttpHeaders;
	method: string | undefined;
	url: string | undefined;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** Runs the exchange against a scripted Controller on 127.0.0.1, recording what it received. */
const exchangingWith = async (
	handler: Handler,
	run: (controllerUrl: URL, received: Received[]) => Promise<ExchangeAnswer>,
): Promise<{ answer: ExchangeAnswer; received: Received[] }> => {
	const received: Received[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			received.push({
				body: Buffer.concat(chunks).toString('utf8'),
				headers: request.headers,
				method: request.method,
				url: request.url,
			});
			handler(request, response);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	try {
		const port = (server.address() as AddressInfo).port;
		const answer = await run(new URL(`http://127.0.0.1:${port}/api/`), received);
		return { answer, received };
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
};

const clientFor = (controllerUrl: URL, responseCapBytes = 1_048_576) =>
	createFetchControllerClient({
		assertion: () => Promise.resolve('assertion-token'),
		controllerUrl,
		payloadVersions: [1],
		responseCapBytes,
	});

const answering =
	(status: number, body = '', headers: Record<string, string> = {}): Handler =>
	(_request, response) => {
		response.writeHead(status, headers);
		response.end(body);
	};

/**
 * A refusal of the exchange as the Controller sends it: its problem details as JSON, `no-store`, and
 * `Retry-After` when the refusal names a time to wait.
 */
const controllerRefusal = (
	problem: { code: string; detail: string; title: string },
	retryAfterSeconds?: number,
): Handler =>
	answering(
		503,
		JSON.stringify({
			code: problem.code,
			detail: problem.detail,
			status: 503,
			title: problem.title,
		}),
		{
			'cache-control': 'no-store',
			'content-type': 'application/problem+json',
			...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
		},
	);

const ADMISSION_SHARE_EXCEEDED = {
	code: 'admissionShareExceeded',
	detail: "The application's exchanges in flight fill its share of the controller, and no connection is free to lend, so no token was issued. Try again once the seconds in Retry-After have passed.",
	title: 'Admission share exceeded',
};

const SIGNING_KEY_UNCONFIRMED = {
	code: 'signingKeyUnconfirmed',
	detail: "The sign-in token's signing key is not confirmed yet, and no token was issued. Try again once the seconds in Retry-After have passed.",
	title: 'Signing key not confirmed yet',
};

const STORE_UNAVAILABLE = {
	code: 'storeUnavailable',
	detail: 'The policy store cannot take this exchange now, and no token was issued. Try again.',
	title: 'Policy store unavailable',
};

const TOKEN_OVER_RESPONSE_CAP = {
	code: 'tokenOverResponseCap',
	detail: "The token for this exchange would hold more than 1048576 bytes, the bridge's default response cap, so no token was issued.",
	title: 'Token over the response cap',
};

const problemBody = (code: unknown): string => JSON.stringify({ code, detail: 'detail', status: 503, title: 'title' });

const exchange = (handler: Handler, credential: string | null = 'sign-in-token', responseCapBytes?: number) =>
	exchangingWith(handler, (controllerUrl) =>
		clientFor(controllerUrl, responseCapBytes).exchange({
			credential,
			signal: AbortSignal.timeout(5_000),
		}),
	);

suite('createFetchControllerClient', () => {
	test('posts the credential and the payload versions to exchange under the base path, with the assertion as Bearer', async () => {
		const { received } = await exchange(answering(200, 'eyJ.token', { 'Content-Type': 'application/jwt' }));

		assert.deepEqual(
			received.map(({ body, headers, method, url }) => ({
				accept: headers['accept'],
				authorization: headers['authorization'],
				body: JSON.parse(body),
				contentType: headers['content-type'],
				method,
				url,
			})),
			[
				{
					accept: 'application/jwt',
					authorization: 'Bearer assertion-token',
					body: { credential: 'sign-in-token', payloadVersions: [1] },
					contentType: 'application/json',
					method: 'POST',
					url: '/api/exchange',
				},
			],
		);
	});

	test('sends no credential member for the anonymous exchange', async () => {
		const { received } = await exchange(answering(200, 'eyJ.token'), null);

		assert.deepEqual(JSON.parse(received[0]?.body ?? '{}'), {
			payloadVersions: [1],
		});
	});

	test('returns the token a 200 carries', async () => {
		const { answer } = await exchange(answering(200, 'eyJ.a.b.c.d\n', { 'Content-Type': 'application/jwt' }));

		assert.deepEqual(answer, { kind: 'token', token: 'eyJ.a.b.c.d' });
	});

	for (const [status, expected] of [
		[403, { kind: 'refused' }],
		[401, { cause: 'assertionRefused', kind: 'unavailable' }],
		[408, { cause: 'status', kind: 'failed' }],
		[500, { cause: 'status', kind: 'failed' }],
		[503, { cause: 'status', kind: 'failed' }],
		[429, { cause: 'status', kind: 'unavailable' }],
		[404, { cause: 'status', kind: 'unavailable' }],
		[204, { cause: 'status', kind: 'unavailable' }],
	] as const) {
		test(`reads a ${status} as ${JSON.stringify(expected)}`, async () => {
			const { answer } = await exchange(answering(status));

			assert.deepEqual(answer, expected);
		});
	}

	test('reads a refusal by its status even when discarding its body fails', async () => {
		const client = createFetchControllerClient({
			assertion: () => Promise.resolve('assertion-token'),
			controllerUrl: new URL('http://controller.invalid/'),
			fetch: () =>
				Promise.resolve({
					body: new ReadableStream<Uint8Array>({
						cancel: () => {
							throw new Error('a body that fails to cancel');
						},
					}),
					headers: { get: () => null },
					status: 403,
				}),
			payloadVersions: [1],
			responseCapBytes: 1_048_576,
		});

		const answer = await client.exchange({
			credential: 'sign-in-token',
			signal: AbortSignal.timeout(5_000),
		});

		assert.deepEqual(answer, { kind: 'refused' });
	});

	test('reads no further than the cap, whether the length is declared or streamed', async () => {
		const declared = await exchange(answering(200, 'x'.repeat(2_000)), 'token', 1_000);
		const streamed = await exchange(
			(_request, response) => {
				response.writeHead(200, { 'Content-Type': 'application/jwt' });
				response.write('x'.repeat(600));
				response.end('x'.repeat(600));
			},
			'token',
			1_000,
		);

		assert.deepEqual(
			[declared.answer, streamed.answer],
			[
				{ kind: 'unreadable', reason: 'tokenTooLarge' },
				{ kind: 'unreadable', reason: 'tokenTooLarge' },
			],
		);
	});

	test('reads an answer exactly at the cap', async () => {
		const { answer } = await exchange(answering(200, 'x'.repeat(1_000)), 'token', 1_000);

		assert.deepEqual(answer, { kind: 'token', token: 'x'.repeat(1_000) });
	});

	test('reads an exchange aborted by its signal as a timeout', async () => {
		const { answer } = await exchangingWith(
			() => undefined,
			(controllerUrl) =>
				clientFor(controllerUrl).exchange({
					credential: 'token',
					signal: AbortSignal.timeout(50),
				}),
		);

		assert.deepEqual(answer, { cause: 'timeout', kind: 'failed' });
	});

	test('reads a refused connection as a network failure', async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => {
			closed.listen(0, '127.0.0.1', resolve);
		});
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => {
			closed.close(() => resolve());
		});

		const answer = await clientFor(new URL(`http://127.0.0.1:${port}/`)).exchange({
			credential: 'token',
			signal: AbortSignal.timeout(5_000),
		});

		assert.deepEqual(answer, { cause: 'network', kind: 'failed' });
	});

	test('follows no redirect, reading one as a network failure', async () => {
		const { answer, received } = await exchange(answering(307, '', { Location: '/api/elsewhere' }));

		assert.deepEqual(answer, { cause: 'network', kind: 'failed' });
		assert.equal(received.length, 1);
	});

	test('reads a throw while signing as a defect, never reaching fetch', async () => {
		const calls: string[] = [];
		const client = createFetchControllerClient({
			assertion: () => Promise.reject(new Error('signing key unavailable')),
			controllerUrl: new URL('http://127.0.0.1:1/api/'),
			fetch: () => {
				calls.push('fetch');
				return Promise.reject(new Error('fetch must not run'));
			},
			payloadVersions: [1],
			responseCapBytes: 1_048_576,
		});

		const answer = await client.exchange({ credential: 'token', signal: AbortSignal.timeout(5_000) });

		assert.deepEqual(answer, { cause: 'defect', kind: 'failed' });
		assert.deepEqual(calls, []);
	});

	suite('a 503', () => {
		test("reads the controller's admissionShareExceeded and signingKeyUnconfirmed, header and body, as the controller sends them", async () => {
			const shed = await exchange(controllerRefusal(ADMISSION_SHARE_EXCEEDED, 1));
			const held = await exchange(controllerRefusal(SIGNING_KEY_UNCONFIRMED, 17));

			assert.deepEqual(
				[shed.answer, held.answer],
				[
					{ kind: 'admissionShareExceeded', retryAfterSeconds: 1 },
					{ kind: 'retryAfter', retryAfterSeconds: 17 },
				],
			);
		});

		for (const [description, handler, expected] of [
			[
				'admissionShareExceeded with no Retry-After',
				controllerRefusal(ADMISSION_SHARE_EXCEEDED),
				{ kind: 'admissionShareExceeded', retryAfterSeconds: undefined },
			],
			[
				'admissionShareExceeded with a Retry-After outside its grammar',
				answering(503, problemBody('admissionShareExceeded'), {
					'retry-after': '1.5',
				}),
				{ kind: 'admissionShareExceeded', retryAfterSeconds: undefined },
			],
			[
				'signingKeyUnconfirmed with no Retry-After',
				controllerRefusal(SIGNING_KEY_UNCONFIRMED),
				{ cause: 'status', kind: 'failed' },
			],
			[
				'storeUnavailable with a Retry-After',
				controllerRefusal(STORE_UNAVAILABLE, 3),
				{ kind: 'retryAfter', retryAfterSeconds: 3 },
			],
			[
				'storeUnavailable with no Retry-After',
				controllerRefusal(STORE_UNAVAILABLE),
				{ cause: 'status', kind: 'failed' },
			],
			[
				'tokenOverResponseCap with no Retry-After',
				controllerRefusal(TOKEN_OVER_RESPONSE_CAP),
				{ cause: 'status', kind: 'failed' },
			],
			[
				'a code the bridge does not know, with a Retry-After',
				answering(503, problemBody('somethingNew'), { 'retry-after': '4' }),
				{ kind: 'retryAfter', retryAfterSeconds: 4 },
			],
			[
				'a code differing from admissionShareExceeded only in case, with a Retry-After',
				answering(503, problemBody('AdmissionShareExceeded'), {
					'retry-after': '4',
				}),
				{ kind: 'retryAfter', retryAfterSeconds: 4 },
			],
			[
				'a code that is not a string, with a Retry-After',
				answering(503, problemBody(['admissionShareExceeded']), {
					'retry-after': '4',
				}),
				{ kind: 'retryAfter', retryAfterSeconds: 4 },
			],
			[
				'a body that is not JSON, with a Retry-After',
				answering(503, 'admissionShareExceeded', { 'retry-after': '5' }),
				{ kind: 'retryAfter', retryAfterSeconds: 5 },
			],
			[
				'a body that is not JSON, with no Retry-After',
				answering(503, 'admissionShareExceeded'),
				{ cause: 'status', kind: 'failed' },
			],
			[
				'no body, with a Retry-After',
				answering(503, '', { 'retry-after': '6' }),
				{ kind: 'retryAfter', retryAfterSeconds: 6 },
			],
			[
				'admissionShareExceeded padded past 2 KiB, with a Retry-After',
				answering(
					503,
					JSON.stringify({
						code: 'admissionShareExceeded',
						detail: 'x'.repeat(2_048),
					}),
					{ 'retry-after': '1' },
				),
				{ kind: 'retryAfter', retryAfterSeconds: 1 },
			],
			[
				'a Retry-After sent with whitespace around it, which fetch returns with the trailing space',
				answering(503, problemBody('signingKeyUnconfirmed'), {
					'retry-after': ' 2 ',
				}),
				{ cause: 'status', kind: 'failed' },
			],
			[
				'two Retry-After lines, which fetch joins into one value',
				((_request, response) => {
					response.writeHead(503, ['retry-after', '1', 'retry-after', '2']);
					response.end(problemBody('signingKeyUnconfirmed'));
				}) satisfies Handler,
				{ cause: 'status', kind: 'failed' },
			],
		] as const) {
			test(`reads ${description} as ${JSON.stringify(expected)}`, async () => {
				const { answer } = await exchange(handler);

				assert.deepEqual(answer, expected);
			});
		}

		test('reads its body no further than the response cap when the cap is under 2 KiB', async () => {
			const { answer } = await exchange(controllerRefusal(ADMISSION_SHARE_EXCEEDED, 1), 'sign-in-token', 100);

			assert.deepEqual(answer, { kind: 'retryAfter', retryAfterSeconds: 1 });
		});

		test('cancels the rest of a body running past 2 KiB, answering before the exchange times out', async () => {
			const signal = AbortSignal.timeout(5_000);
			const closing = { atServer: (): void => undefined };
			const closedAtServer = new Promise<'closed'>((resolve) => {
				closing.atServer = () => resolve('closed');
			});
			const stillOpen = (): Promise<'still open'> =>
				new Promise((resolve) => {
					setTimeout(() => resolve('still open'), 2_000).unref();
				});
			const ended = { atServer: '' };
			const { answer } = await exchangingWith(
				(_request, response) => {
					response.on('close', closing.atServer);
					response.writeHead(503, {
						'content-type': 'application/problem+json',
						'retry-after': '7',
					});
					response.write(problemBody('admissionShareExceeded').slice(0, -1));
					// The body never ends, so only a cancel ends the connection before the signal aborts.
					response.write(`,"padding":"${'x'.repeat(3_072)}`);
				},
				async (controllerUrl) => {
					const read = await clientFor(controllerUrl).exchange({
						credential: 'sign-in-token',
						signal,
					});
					ended.atServer = await Promise.race([closedAtServer, stillOpen()]);
					return read;
				},
			);

			assert.deepEqual(answer, { kind: 'retryAfter', retryAfterSeconds: 7 });
			assert.equal(signal.aborted, false);
			assert.equal(ended.atServer, 'closed');
		});

		test('reads a failure while reading its body as a network failure', async () => {
			const client = createFetchControllerClient({
				assertion: () => Promise.resolve('assertion-token'),
				controllerUrl: new URL('http://controller.invalid/'),
				fetch: () =>
					Promise.resolve({
						body: new ReadableStream<Uint8Array>({
							pull: () => {
								throw new Error('a connection reset mid-body');
							},
						}),
						headers: {
							get: (name: string) => (name === 'retry-after' ? '1' : null),
						},
						status: 503,
					}),
				payloadVersions: [1],
				responseCapBytes: 1_048_576,
			});

			const answer = await client.exchange({
				credential: 'sign-in-token',
				signal: AbortSignal.timeout(5_000),
			});

			assert.deepEqual(answer, { cause: 'network', kind: 'failed' });
		});
	});
});

suite('retryAfterSecondsOf', () => {
	for (const [value, expected] of [
		['1', 1],
		['30', 30],
		['000001', 1],
		['6', 6],
		['61', 61],
		['999999', 999_999],
		['0', undefined],
		['000000', undefined],
		['-1', undefined],
		['+1', undefined],
		['1.5', undefined],
		['1e3', undefined],
		['1, 2', undefined],
		['Wed, 21 Oct 2026 07:28:00 GMT', undefined],
		['', undefined],
		[' 1', undefined],
		['1\n', undefined],
		['1000000', undefined],
		['\u0661', undefined],
		[null, undefined],
	] as const) {
		test(`reads ${JSON.stringify(value)} as ${String(expected)}`, () => {
			assert.equal(retryAfterSecondsOf(value), expected);
		});
	}

	test('reads every string outside 1 to 6 ASCII digits as absent', () => {
		fastCheck.assert(
			fastCheck.property(
				fastCheck.string({ unit: 'binary' }).filter((value) => !/^[0-9]{1,6}$/u.test(value)),
				(value) => retryAfterSecondsOf(value) === undefined,
			),
		);
	});

	test('reads 1 to 6 ASCII digits as the whole seconds they name, or absent when they name none', () => {
		fastCheck.assert(
			fastCheck.property(
				fastCheck.stringMatching(/^[0-9]{1,6}$/u),
				(value) => retryAfterSecondsOf(value) === (Number(value) > 0 ? Number(value) : undefined),
			),
		);
	});
});
