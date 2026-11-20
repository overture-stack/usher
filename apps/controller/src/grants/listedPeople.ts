import type { AccountReading, Directory } from '../directory/index.js';
import type { JsonValue } from '../eventLog/index.js';

/**
 * How a listing names a person holding neither a given nor a family name in the directory, one the
 * directory no longer holds, and anyone while no directory is configured.
 */
export const UNNAMED_PERSON = 'a data steward';

/** The most lookups one listing holds open with the directory at once. */
export const LOOKUPS_AT_ONCE = 8;

/** A person as a listing shows them, read from the directory when the listing is written. */
export interface ListedPerson {
	/**
	 * The address the directory holds now; none for an account holding none, for an account the
	 * directory no longer holds, and with no directory configured.
	 */
	email: string | undefined;

	/**
	 * Whether an account holds the person: false only for one the directory no longer holds, and true
	 * for every person the store holds while no directory is configured.
	 */
	hasAccount: boolean;

	/** The directory's given and family names, or {@link UNNAMED_PERSON} for one holding neither. */
	name: string;
}

/** The people a listing names, by subject, or a directory that cannot answer for one of them. */
export type PeopleReading = { kind: 'read'; people: ReadonlyMap<string, ListedPerson> } | { kind: 'unavailable' };

/** How a listing shows a grant's holder, and any other person it names. */
export interface PeopleNaming {
	/**
	 * A holder: `subject`, `email` where one is held, and `hasAccount`.
	 *
	 * @param subject the holder's subject.
	 */
	holder(subject: string): JsonValue;

	/**
	 * A granter or a revoker: `{ subject }` or `{ name }`, as the reader is shown people.
	 *
	 * @param subject the person's subject.
	 */
	principal(subject: string): JsonValue;
}

const UNREAD: ListedPerson = Object.freeze({
	email: undefined,
	hasAccount: true,
	name: UNNAMED_PERSON,
});

const nameOf = (names: readonly (string | null)[]): string => {
	const held = names.filter((name): name is string => name !== null && name.trim() !== '');
	return held.length > 0 ? held.join(' ') : UNNAMED_PERSON;
};

const listedPersonOf = (reading: Exclude<AccountReading, { kind: 'unavailable' }>): ListedPerson => {
	if (reading.kind === 'held') {
		const { email, familyName, givenName } = reading.account;
		return {
			email: email ?? undefined,
			hasAccount: true,
			name: nameOf([givenName, familyName]),
		};
	}
	return reading.kind === 'absent' ? { ...UNREAD, hasAccount: false } : UNREAD;
};

const batchesOf = (subjects: readonly string[]): readonly (readonly string[])[] =>
	Array.from({ length: Math.ceil(subjects.length / LOOKUPS_AT_ONCE) }, (_, index) =>
		subjects.slice(index * LOOKUPS_AT_ONCE, (index + 1) * LOOKUPS_AT_ONCE),
	);

/**
 * Reads the people a listing names from the directory, each person once, in batches of at most
 * {@link LOOKUPS_AT_ONCE} lookups at once, asking nothing for no one. A person with no directory
 * configured holds an account and no address, and is named {@link UNNAMED_PERSON}; one the
 * directory no longer holds is named so too, and holds no account. A directory that cannot answer
 * for any one of them reads as unavailable whole, and is asked nothing after the batch holding that
 * lookup.
 *
 * @param directory where each person's account is read.
 * @param subjects the people's subjects, in any order, any of them more than once.
 */
export const readListedPeople = async (
	directory: Pick<Directory, 'accountOf'>,
	subjects: readonly string[],
): Promise<PeopleReading> =>
	batchesOf([...new Set(subjects)]).reduce<Promise<PeopleReading>>(
		async (earlier, batch) => {
			const read = await earlier;
			if (read.kind === 'unavailable') {
				return read;
			}
			const readings = await Promise.all(
				batch.map(async (subject) => {
					const reading = await directory.accountOf(subject);
					return reading.kind === 'unavailable' ? undefined : ([subject, listedPersonOf(reading)] as const);
				}),
			);
			const listed = readings.flatMap((entry) => (entry === undefined ? [] : [entry]));
			return listed.length === readings.length
				? { kind: 'read', people: new Map([...read.people, ...listed]) }
				: { kind: 'unavailable' };
		},
		Promise.resolve({ kind: 'read', people: new Map() }),
	);

/**
 * How a listing shows the people it names: each holder by subject, with the address the directory
 * holds where it holds one and whether an account holds them; any other person by subject alone, as
 * a platform administrator is shown people, or by name alone, as anyone else is.
 *
 * @param people the people read for the listing, by subject.
 * @param principals whether a person other than a holder is shown by `subject` or by `name`.
 */
export const namingBy = (people: ReadonlyMap<string, ListedPerson>, principals: 'name' | 'subject'): PeopleNaming => {
	const personOf = (subject: string): ListedPerson => people.get(subject) ?? UNREAD;
	return {
		holder: (subject) => {
			const { email, hasAccount } = personOf(subject);
			return {
				...(email === undefined ? {} : { email }),
				hasAccount,
				subject,
			};
		},
		principal: (subject) => (principals === 'subject' ? { subject } : { name: personOf(subject).name }),
	};
};
