import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import type { AccountReading } from '../directory/index.js';
import { LOOKUPS_AT_ONCE, namingBy, readListedPeople, UNNAMED_PERSON } from './listedPeople.js';

// A directory answering each subject from the readings given, keeping each subject asked and the
// most lookups it held open at once.
const answering = (
	readings: Readonly<Record<string, AccountReading>>,
): {
	asked: string[];
	directory: { accountOf(subject: string): Promise<AccountReading> };
	mostAtOnce: () => number;
} => {
	const asked: string[] = [];
	const open = { most: 0, now: 0 };
	return {
		asked,
		directory: {
			accountOf: async (subject) => {
				asked.push(subject);
				open.now += 1;
				open.most = Math.max(open.most, open.now);
				await new Promise((resolve) => setImmediate(resolve));
				open.now -= 1;
				return readings[subject] ?? { kind: 'absent' };
			},
		},
		mostAtOnce: () => open.most,
	};
};

const held = (
	givenName: string | null,
	familyName: string | null,
	email: string | null = 'person@example.org',
): AccountReading => ({
	account: { email, familyName, givenName },
	kind: 'held',
});

const peopleOf = async (readings: Readonly<Record<string, AccountReading>>, subjects: readonly string[]) => {
	const read = await readListedPeople(answering(readings).directory, subjects);
	return read.kind === 'read' ? Object.fromEntries(read.people) : read;
};

suite('naming the people a listing shows', () => {
	test("names a person by the directory's given and family names, by either alone, and by the fallback for neither", async () => {
		const people = await peopleOf(
			{
				both: held('Ana', 'Example'),
				family: held(null, 'Example'),
				given: held('Hal', null),
				neither: held(null, null),
				blank: held(' ', ''),
			},
			['both', 'family', 'given', 'neither', 'blank'],
		);

		assert.deepEqual(
			Object.entries(people).map(([subject, { name }]) => [subject, name]),
			[
				['both', 'Ana Example'],
				['family', 'Example'],
				['given', 'Hal'],
				['neither', UNNAMED_PERSON],
				['blank', UNNAMED_PERSON],
			],
		);
		assert.equal(UNNAMED_PERSON, 'a data steward');
	});

	test('holds the address the directory holds, an account it no longer holds as having none, and with no directory configured an account with no address', async () => {
		const people = await peopleOf(
			{
				deleted: { kind: 'absent' },
				held: held('Ana', 'Example', 'ana@example.org'),
				noAddress: held('Bo', 'Example', null),
				unconfigured: { kind: 'unconfigured' },
			},
			['held', 'noAddress', 'deleted', 'unconfigured'],
		);

		assert.deepEqual(people, {
			deleted: { email: undefined, hasAccount: false, name: UNNAMED_PERSON },
			held: { email: 'ana@example.org', hasAccount: true, name: 'Ana Example' },
			noAddress: { email: undefined, hasAccount: true, name: 'Bo Example' },
			unconfigured: {
				email: undefined,
				hasAccount: true,
				name: UNNAMED_PERSON,
			},
		});
	});

	test('asks the directory once for each person, a bounded number at once, and nothing for nobody', async () => {
		const subjects = Array.from({ length: 20 }, (_, index) => `s-${index}`);
		const many = answering({});
		const none = answering({});

		await readListedPeople(many.directory, [...subjects, ...subjects]);
		await readListedPeople(none.directory, []);

		assert.deepEqual(many.asked.toSorted(), subjects.toSorted());
		assert.equal(many.mostAtOnce(), LOOKUPS_AT_ONCE);
		assert.deepEqual(none.asked, []);
	});

	test('reads as unavailable once any lookup is, asking nothing more once a lookup has failed', async () => {
		const subjects = Array.from({ length: LOOKUPS_AT_ONCE * 3 }, (_, index) => `s-${index}`);
		const failing = answering({ 's-0': { kind: 'unavailable' } });

		const read = await readListedPeople(failing.directory, subjects);

		assert.deepEqual(read, { kind: 'unavailable' });
		assert.equal(failing.asked.length, LOOKUPS_AT_ONCE);
	});
});

suite('showing the people a listing names', () => {
	const people = new Map([
		['subject-ana', { email: 'ana@example.org', hasAccount: true, name: 'Ana Example' }],
		['subject-fay', { email: undefined, hasAccount: false, name: UNNAMED_PERSON }],
	]);

	test('shows a holder by subject, the address held and whether an account holds them, whoever reads', () => {
		const shown = (['subject', 'name'] as const).map((principals) => {
			const naming = namingBy(people, principals);
			return [naming.holder('subject-ana'), naming.holder('subject-fay')];
		});

		assert.deepEqual(shown, [
			[
				{ email: 'ana@example.org', hasAccount: true, subject: 'subject-ana' },
				{ hasAccount: false, subject: 'subject-fay' },
			],
			[
				{ email: 'ana@example.org', hasAccount: true, subject: 'subject-ana' },
				{ hasAccount: false, subject: 'subject-fay' },
			],
		]);
	});

	test('shows any other person by subject alone, or by name alone', () => {
		assert.deepEqual(
			[
				namingBy(people, 'subject').principal('subject-ana'),
				namingBy(people, 'name').principal('subject-ana'),
				namingBy(people, 'name').principal('subject-fay'),
			],
			[{ subject: 'subject-ana' }, { name: 'Ana Example' }, { name: UNNAMED_PERSON }],
		);
	});
});
