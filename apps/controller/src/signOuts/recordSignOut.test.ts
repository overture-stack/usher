import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import pg from 'pg';

import type { AuditEvent, AuditTransaction } from '../eventLog/index.js';
import { recordSignOut } from './recordSignOut.js';
import type { SignOut, SignOutRecordContext } from './types.js';

const ISSUED_AT = Math.floor(Date.UTC(2026, 10, 9, 12, 0, 0) / 1000);

const RETENTION_SECONDS = 3600;

const CONTEXT: SignOutRecordContext = Object.freeze({
	issuer: 'https://auth.example.org/realms/usher',
	retentionSeconds: RETENTION_SECONDS,
	schema: 'usher',
	sourceIp: '192.0.2.10',
});

const SIGNED_OUT_AT = new Date(ISSUED_AT * 1000);

const ENDS_AT = new Date((ISSUED_AT + RETENTION_SECONDS) * 1000);

interface Statement {
	text: string;
	values: readonly unknown[] | undefined;
}

interface Stand {
	recorded: AuditEvent[];
	statements: Statement[];
	transaction: AuditTransaction<pg.ClientBase>;
}

// A transaction whose first statement, the sign-out's own, is answered with the rows given, and every
// later one with none, each statement and event kept.
const standUp = (signOutRows: readonly Record<string, unknown>[]): Stand => {
	const statements: Statement[] = [];
	const recorded: AuditEvent[] = [];
	const query = async (text: string, values?: readonly unknown[]) => {
		statements.push({ text, values });
		return { rows: statements.length === 1 ? signOutRows : [] };
	};
	return {
		recorded,
		statements,
		transaction: {
			// A client that never connects, its query answered here: the client's overloads are more than a
			// fake can spell out.
			connection: Object.assign(new pg.Client(), { query }),
			record: async (event) => {
				recorded.push(event);
				return 'event-id';
			},
		},
	};
};

const SESSION_SIGN_OUT: SignOut = Object.freeze({
	issuedAt: ISSUED_AT,
	kind: 'session',
	sessionId: 'session-1',
	subject: 'subject-ana',
});

const SUBJECT_SIGN_OUT: SignOut = Object.freeze({
	issuedAt: ISSUED_AT,
	kind: 'subject',
	subject: 'subject-ana',
});

const signOutEvent = (subject?: string): AuditEvent => ({
	data: {
		result: 'succeeded',
		...(subject === undefined ? {} : { signedOutUserSubject: subject }),
		sourceIp: CONTEXT.sourceIp,
	},
	severity: 'info',
	type: 'identity.signOut',
});

suite('recording the sign-out of a session', () => {
	test('records the session under the issuer with its subject, when it was signed out and when its record ends, then one principal notice and the event naming the subject', async () => {
		const stand = standUp([{ subject: 'subject-ana' }]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, SESSION_SIGN_OUT);

		assert.deepEqual(recording, { kind: 'recorded', subject: 'subject-ana' });
		assert.equal(stand.statements.length, 2);
		assert.match(stand.statements[0]?.text ?? '', /"usher"\.sid_sign_outs/u);
		assert.deepEqual(stand.statements[0]?.values, [
			CONTEXT.issuer,
			'session-1',
			'subject-ana',
			SIGNED_OUT_AT,
			ENDS_AT,
		]);
		assert.match(stand.statements[1]?.text ?? '', /"usher"\.notices/u);
		assert.deepEqual(stand.statements[1]?.values, ['subject-ana']);
		assert.deepEqual(stand.recorded, [signOutEvent('subject-ana')]);
	});

	test('names in its notice the subject the store gives for a session the token names alone', async () => {
		const stand = standUp([{ subject: 'subject-bo' }]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, {
			...SESSION_SIGN_OUT,
			subject: undefined,
		});

		assert.deepEqual(recording, { kind: 'recorded', subject: 'subject-bo' });
		assert.equal(stand.statements[0]?.values?.[2], null);
		assert.deepEqual(stand.statements[1]?.values, ['subject-bo']);
		assert.deepEqual(stand.recorded, [signOutEvent('subject-bo')]);
	});

	test('writes no notice for a session recorded with no subject known, and records its event naming no one signed out, never empty or null', async () => {
		const stand = standUp([{ subject: null }]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, {
			...SESSION_SIGN_OUT,
			subject: undefined,
		});

		assert.deepEqual(recording, { kind: 'recorded', subject: undefined });
		assert.equal(stand.statements.length, 1);
		assert.deepEqual(stand.recorded, [signOutEvent()]);
		assert.equal(Object.hasOwn(stand.recorded[0]?.data ?? {}, 'signedOutUserSubject'), false);
	});

	test('writes nothing more for a sign-out the store holds already: no notice and no event', async () => {
		const stand = standUp([]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, SESSION_SIGN_OUT);

		assert.deepEqual(recording, { kind: 'held' });
		assert.equal(stand.statements.length, 1);
		assert.deepEqual(stand.recorded, []);
	});
});

suite('recording the sign-out of a subject alone', () => {
	test('records the subject under the issuer, when it was signed out and when its record ends, then one principal notice and the event naming it', async () => {
		const stand = standUp([{ subject: 'subject-ana' }]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, SUBJECT_SIGN_OUT);

		assert.deepEqual(recording, { kind: 'recorded', subject: 'subject-ana' });
		assert.match(stand.statements[0]?.text ?? '', /"usher"\.subject_sign_outs/u);
		assert.deepEqual(stand.statements[0]?.values, [CONTEXT.issuer, 'subject-ana', SIGNED_OUT_AT, ENDS_AT]);
		assert.deepEqual(stand.statements[1]?.values, ['subject-ana']);
		assert.deepEqual(stand.recorded, [signOutEvent('subject-ana')]);
	});

	test('writes nothing more for a sign-out the store holds as recent or more recent', async () => {
		const stand = standUp([]);

		const recording = await recordSignOut(stand.transaction, CONTEXT, SUBJECT_SIGN_OUT);

		assert.deepEqual(recording, { kind: 'held' });
		assert.equal(stand.statements.length, 1);
		assert.deepEqual(stand.recorded, []);
	});
});
