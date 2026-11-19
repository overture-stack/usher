import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { readLogoutRequest } from './readLogoutRequest.js';

const FORM = 'application/x-www-form-urlencoded';

const PATH = '/backchannel-logout';

// Opaque text standing for a token: the reader judges only where it is carried, and its characters
// that form encoding escapes show the value is read decoded.
const TOKEN = 'opaque.logout-token_value+/=';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const formOf = (entries: readonly [string, string][]): Uint8Array =>
	bytes(new URLSearchParams([...entries]).toString());

const codeOf = (reading: ReturnType<typeof readLogoutRequest>): string =>
	reading.kind === 'refused' ? reading.problem.code : 'read';

suite('reading a back-channel logout request', () => {
	test('reads the token from a form-encoded body holding one logout_token', () => {
		const reading = readLogoutRequest({
			body: formOf([['logout_token', TOKEN]]),
			contentType: FORM,
			url: PATH,
		});

		assert.deepEqual(reading, { kind: 'read', token: TOKEN });
	});

	test('reads it under the form media type in any letter case, with parameters', () => {
		const reading = readLogoutRequest({
			body: formOf([['logout_token', TOKEN]]),
			contentType: 'Application/X-WWW-Form-URLEncoded; charset=UTF-8',
			url: PATH,
		});

		assert.deepEqual(reading, { kind: 'read', token: TOKEN });
	});

	test('reads it beside parameters it does not take, leaving them unread', () => {
		const reading = readLogoutRequest({
			body: formOf([
				['state', 'signed-out'],
				['logout_token', TOKEN],
			]),
			contentType: FORM,
			url: PATH,
		});

		assert.deepEqual(reading, { kind: 'read', token: TOKEN });
	});

	test('refuses a body holding no logout_token, an empty one, or one twice, as an unreadable body', () => {
		const bodies = [
			formOf([['state', 'signed-out']]),
			formOf([['logout_token', '']]),
			formOf([
				['logout_token', TOKEN],
				['logout_token', TOKEN],
			]),
			bytes(''),
		];

		const codes = bodies.map((body) => codeOf(readLogoutRequest({ body, contentType: FORM, url: PATH })));

		assert.deepEqual(codes, ['unreadableBody', 'unreadableBody', 'unreadableBody', 'unreadableBody']);
	});

	test('refuses a body of any other media type, JSON among them, or of none, and a request with no body', () => {
		const json = bytes(JSON.stringify({ logout_token: TOKEN }));
		const form = formOf([['logout_token', TOKEN]]);

		const codes = [
			readLogoutRequest({
				body: json,
				contentType: 'application/json',
				url: PATH,
			}),
			readLogoutRequest({ body: form, contentType: 'text/plain', url: PATH }),
			readLogoutRequest({
				body: form,
				contentType: 'application/x-www-form-urlencoded-extra',
				url: PATH,
			}),
			readLogoutRequest({ body: form, contentType: undefined, url: PATH }),
			readLogoutRequest({ body: undefined, contentType: FORM, url: PATH }),
		].map(codeOf);

		assert.deepEqual(codes, [
			'unreadableBody',
			'unreadableBody',
			'unreadableBody',
			'unreadableBody',
			'unreadableBody',
		]);
	});

	test('refuses a body that is not UTF-8', () => {
		const body = Uint8Array.from([...bytes('logout_token='), 0xc3, 0x28, ...bytes(TOKEN)]);

		const reading = readLogoutRequest({ body, contentType: FORM, url: PATH });

		assert.equal(codeOf(reading), 'unreadableBody');
	});

	test('refuses any query, one carrying the token among them, before reading the body', () => {
		const form = formOf([['logout_token', TOKEN]]);
		const urls = [`${PATH}?logout_token=${TOKEN}`, `${PATH}?state=signed-out`, `${PATH}?`];

		const codes = urls.map((url) => codeOf(readLogoutRequest({ body: form, contentType: FORM, url })));

		assert.deepEqual(codes, ['unreadableQuery', 'unreadableQuery', 'unreadableQuery']);
	});
});
