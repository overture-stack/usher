import type { Directory } from '../directory/index.js';
import type { JsonValue } from '../eventLog/index.js';
import { type ManagementOperation, type OperationOutcome, pageOf, type StoreReader } from '../managementApi/index.js';
import { maySee, readResourceStanding } from '../resourceStanding/index.js';
import { unnamedByDirectory, unresolvedByDirectory } from './directoryOutcome.js';
import { type ListedGrant, ownsAnyResource, readGrantPage, readGrantsOn } from './grantListingPage.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantView } from './grantView.js';
import { cursorAfterId } from './idCursor.js';
import { namingBy, readListedPeople } from './listedPeople.js';
import { answered, refused } from './operationOutcome.js';
import { readGrantListing, readPersonGrantListing } from './readGrantListing.js';
import type { GrantListing, GrantOperationsSettings, GrantsOnResources, PersonGrantListing } from './types.js';

/**
 * How a grant listing shows the people it names beside each holder: by `subject`, to a platform
 * administrator, or by `name`; and whether each grant shows what its role confers now.
 */
interface ListingShape {
	principals: 'name' | 'subject';
	withCapabilities: boolean;
}

/**
 * A grant listing's answer: 200 with a page of the grants read, `{ grants, next }`, each grant as
 * {@link grantView} shows it, its holder with the address the directory holds and whether an
 * account holds them, and its granter and revoker as the shape says. The directory is asked for
 * each person the page names that way, and for nobody on an empty page; while it cannot answer, the
 * listing is answered as {@link unnamedByDirectory} decides.
 *
 * @param directory where each person is read.
 * @param read the grants read for the page, one more than it holds where another page follows.
 * @param limit the most grants on the page.
 * @param now the configured clock's instant, in milliseconds since the Unix epoch.
 * @param shape how people are shown, and whether capabilities are.
 */
const grantsAnswer = async (
	directory: Pick<Directory, 'accountOf'>,
	read: readonly ListedGrant[],
	limit: number,
	now: number,
	{ principals, withCapabilities }: ListingShape,
): Promise<OperationOutcome> => {
	const { entries, next } = pageOf(read, limit, ({ id }) => cursorAfterId(id));
	const named = entries.flatMap(({ granterSubject, holderSubject, revokerSubject }) => [
		holderSubject,
		...(principals === 'name' ? [granterSubject, ...(revokerSubject === null ? [] : [revokerSubject])] : []),
	]);
	const people = await readListedPeople(directory, named);
	if (people.kind === 'unavailable') {
		return unnamedByDirectory();
	}
	const naming = namingBy(people.people, principals);
	return answered(200, {
		grants: entries.map((grant) =>
			grantView(grant, now, {
				...(withCapabilities ? { capabilities: grant.capabilities } : {}),
				naming,
			}),
		),
		next,
	});
};

/**
 * The operation listing the principal's own grants, `GET /admin/me/grants`, reading its query with
 * {@link readGrantListing} and its page with {@link readGrantPage} outside any transaction, at the
 * configured clock's instant. Any signed-in principal lists the grants they hold, pending, declined
 * and expired ones included, revoked ones only to a platform administrator asking for them, and on
 * a retired resource none but a revoked one; a principal holding nothing is answered an empty page.
 * Each grant shows what its role confers now, with each capability's display name and description,
 * and names its granter and its revoker by name alone, as {@link grantsAnswer} answers. It records
 * no event, and a service account is refused 403 `serviceAccountNotPermitted`.
 *
 * @param operations the directory, the settings and the store reader.
 */
export const ownGrantListingOperation = ({
	directory,
	settings: { clock, databaseSchema, identityProviderIssuer },
	store,
}: GrantOperationsSettings): ManagementOperation<GrantListing> => ({
	administratorOnly: false,
	body: 'none',
	method: 'GET',
	readInput: (_body, context) => readGrantListing(context),
	route: '/admin/me/grants',
	run: async ({ input, principal }) => {
		const now = clock.now();
		const read = await readGrantPage(store, databaseSchema, {
			...input,
			issuer: identityProviderIssuer,
			now: new Date(now),
			scope: {
				holderSubject: principal.subject,
				kind: 'held',
				ownerSubject: undefined,
			},
		});
		return grantsAnswer(directory, read, input.limit, now, {
			principals: 'name',
			withCapabilities: true,
		});
	},
	takesQuery: true,
});

/**
 * The operation listing the grants on a resource, `GET /admin/resources/{externalId}/grants`, the
 * externalId matched exactly, reading its query with {@link readGrantListing}, then the principal's
 * standing on the resource and the page with {@link readGrantPage}, each outside any transaction,
 * at the configured clock's instant. A principal who may not see the resource, a retired one seen
 * only by a platform administrator, is answered 404 `resourceNotFound` exactly as for one that does
 * not exist; one who may see it and is neither a platform administrator nor a counted owner of it,
 * 403 `noAuthorityOnResource`. Every grant held by a person on it is listed, expired, pending and
 * declined ones included, revoked ones only to a platform administrator asking for them; each
 * granter and revoker is shown by subject to a platform administrator and by name to an owner, as
 * {@link grantsAnswer} answers. It records no event, and a service account is refused 403
 * `serviceAccountNotPermitted`.
 *
 * @param operations the directory, the settings and the store reader.
 */
export const resourceGrantListingOperation = ({
	directory,
	settings: { clock, databaseSchema, identityProviderIssuer },
	store,
}: GrantOperationsSettings): ManagementOperation<GrantListing> => ({
	administratorOnly: false,
	body: 'none',
	method: 'GET',
	readInput: (_body, context) => readGrantListing(context),
	route: '/admin/resources/{externalId}/grants',
	run: async ({ input, params, principal }) => {
		const now = clock.now();
		const standing = await readResourceStanding(store, databaseSchema, {
			externalId: params['externalId'] ?? '',
			issuer: identityProviderIssuer,
			lock: 'none',
			now: new Date(now),
			subject: principal.subject,
		});
		if (
			standing === undefined ||
			!maySee(standing, {
				administrator: principal.administrator,
				asksForRetired: true,
			})
		) {
			return refused(GRANT_PROBLEMS.resourceNotFound);
		}
		if (!principal.administrator && !standing.countedOwner) {
			return refused(GRANT_PROBLEMS.noAuthorityOnResource);
		}
		const read = await readGrantPage(store, databaseSchema, {
			...input,
			issuer: identityProviderIssuer,
			now: new Date(now),
			scope: { kind: 'on', resourceId: standing.id },
		});
		return grantsAnswer(directory, read, input.limit, now, {
			principals: principal.administrator ? 'subject' : 'name',
			withCapabilities: false,
		});
	},
	takesQuery: true,
});

const NO_GRANTS = Object.freeze({ grants: [], next: null });

/**
 * The operation listing a person's grants, `POST /admin/people/grants`, reading its body and its
 * query with {@link readPersonGrantListing}, outside any transaction, at the configured clock's
 * instant. A principal neither a platform administrator nor a counted owner of any resource is
 * answered an empty page whatever the address, and the directory is asked nothing. Anyone else has
 * the address resolved through the directory, exactly and in any letter case, and a directory
 * resolving nothing is answered as {@link unresolvedByDirectory} decides, offering a resource's
 * grants in its place. An address held by no single account is refused 404 `holderNotFound` to a
 * platform administrator, and answered an empty page to an owner, as for an account holding nothing
 * on their resources. A platform administrator is listed every grant the account's person holds,
 * and an owner those on resources they are a counted owner of; revoked ones only to a platform
 * administrator asking for them, and on a retired resource none but a revoked one. Each granter and
 * revoker is shown by subject to a platform administrator and by name to an owner, as {@link
 * grantsAnswer} answers. It records no event, and a service account is refused 403
 * `serviceAccountNotPermitted`.
 *
 * @param operations the directory, the settings and the store reader.
 */
export const personGrantListingOperation = ({
	directory,
	settings: { clock, databaseSchema, identityProviderIssuer },
	store,
}: GrantOperationsSettings): ManagementOperation<PersonGrantListing> => ({
	administratorOnly: false,
	body: 'required',
	method: 'POST',
	readInput: readPersonGrantListing,
	route: '/admin/people/grants',
	run: async ({ input, principal }) => {
		const now = clock.now();
		const mayList =
			principal.administrator ||
			(await ownsAnyResource(store, databaseSchema, {
				issuer: identityProviderIssuer,
				now: new Date(now),
				subject: principal.subject,
			}));
		if (!mayList) {
			return answered(200, NO_GRANTS);
		}
		const resolution = await directory.resolveAddress(input.email);
		if (resolution.kind === 'unavailable' || resolution.kind === 'unconfigured') {
			return unresolvedByDirectory(resolution, 'grantsByResource');
		}
		if (resolution.kind === 'unheld') {
			return principal.administrator ? refused(GRANT_PROBLEMS.noHolderOfAddress) : answered(200, NO_GRANTS);
		}
		const read = await readGrantPage(store, databaseSchema, {
			...input,
			issuer: identityProviderIssuer,
			now: new Date(now),
			scope: {
				holderSubject: resolution.subject,
				kind: 'held',
				ownerSubject: principal.administrator ? undefined : principal.subject,
			},
		});
		return grantsAnswer(directory, read, input.limit, now, {
			principals: principal.administrator ? 'subject' : 'name',
			withCapabilities: false,
		});
	},
	takesQuery: true,
});

/**
 * The grants on each of a page of resources, as a platform administrator's resource listing shows
 * them: every unrevoked grant held by a person, as {@link grantView} shows it at the configured
 * clock's instant, each holder by subject with the address the directory holds and whether an
 * account holds them, and each granter by subject. The directory is asked for each holder, and for
 * nobody where the resources hold no grant; while it cannot answer, the listing is answered as
 * {@link unnamedByDirectory} decides.
 *
 * @param reading the directory, the store reader, the schema and the trusted issuer.
 * @param question the resources' ids, and the configured clock's instant in milliseconds.
 */
export const grantsOnResources = async (
	{
		directory,
		issuer,
		schema,
		store,
	}: {
		directory: Pick<Directory, 'accountOf'>;
		issuer: string;
		schema: string;
		store: StoreReader;
	},
	{ now, resourceIds }: { now: number; resourceIds: readonly string[] },
): Promise<GrantsOnResources> => {
	const read = await readGrantsOn(store, schema, { issuer, resourceIds });
	const people = await readListedPeople(
		directory,
		read.map(({ holderSubject }) => holderSubject),
	);
	if (people.kind === 'unavailable') {
		return { kind: 'unavailable', outcome: unnamedByDirectory() };
	}
	const naming = namingBy(people.people, 'subject');
	const shown = read.map((grant) => [grant.resourceId, grantView(grant, now, { naming })] as const);
	return {
		grantsOf: (resourceId): readonly JsonValue[] =>
			shown.flatMap(([on, view]) => (on === resourceId ? [view] : [])),
		kind: 'listed',
	};
};
