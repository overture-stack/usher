import type { RouteOptions } from 'fastify';

import { findApplication } from '../applications/index.js';
import type { Actor, AuditEvent, JsonValue } from '../eventLog/index.js';
import { ControllerError } from '../failures/index.js';
import { findOrRecordPerson } from '../findOrRecordPerson.js';
import { type GrantStore, grantsOnResources, type GrantToWrite, sqlGrantStore, writeGrant } from '../grants/index.js';
import type { Problem } from '../http/index.js';
import {
	type InputReading,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	type OperationOutcome,
	pageOf,
	type Principal,
} from '../managementApi/index.js';
import { maySee, type ResourceStanding } from '../resourceStanding/index.js';
import { cursorAfter, readListingQuery } from './listingQuery.js';
import { ownerSubjects } from './ownerSubjects.js';
import { readRegistration } from './readRegistration.js';
import { RESOURCE_PROBLEMS } from './resourceProblems.js';
import {
	findResource,
	insertResource,
	readNamedServing,
	readResource,
	readResourcePage,
	registeredApplications,
	serveResource,
	stopServingResource,
} from './resourceStore.js';
import { resourceView } from './resourceView.js';
import type { ListingQuery, Reader, Registration, ResourceOperationsSettings } from './types.js';

// A refusal reached inside a change's transaction, thrown so the transaction rolls back and nothing
// of the change is written, a person first met in it included.
class RefusedWithin extends Error {
	readonly problem: Problem;

	constructor(problem: Problem) {
		super(problem.code);
		this.problem = problem;
	}
}

const refuseWithin = (problem: Problem): never => {
	throw new RefusedWithin(problem);
};

const ownerRoleMissing = (): never => {
	throw new ControllerError('the store holds no owner role');
};

// The resource is new to the registration's transaction, so no grant on it is held already.
const ownerGrantUnwritten = (): never => {
	throw new ControllerError('an owner grant on a resource being registered was not written');
};

// Writes an owner grant on a resource being registered for each person named, in turn, each with
// its `grant.creation`, and with its holder's acceptance under auto-accept.
const writeOwnerGrants = async ({
	autoAccept,
	grants,
	granter,
	holderSubjects,
	now,
	record,
	resource,
	sourceIp,
}: Pick<GrantToWrite, 'autoAccept' | 'granter' | 'resource' | 'sourceIp'> & {
	grants: GrantStore;
	holderSubjects: readonly string[];
	now: Date;
	record: (event: AuditEvent) => Promise<string>;
}): Promise<void> => {
	if (holderSubjects.length === 0) {
		return;
	}
	const role = (await grants.findRole('owner')) ?? ownerRoleMissing();
	await holderSubjects.reduce<Promise<unknown>>(
		(earlier, holderSubject) =>
			earlier.then(
				async () =>
					(await writeGrant(grants, record, {
						autoAccept,
						category: null,
						expiresAt: null,
						grantedAt: now,
						granter,
						holderSubject,
						resource,
						role,
						sourceIp,
					})) ?? ownerGrantUnwritten(),
			),
		Promise.resolve(),
	);
};

const refused = (problem: Problem): OperationOutcome => ({
	kind: 'refused',
	problem,
});

const answered = (status: number, body: JsonValue | undefined): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it
// written. Any other failure is thrown on, as the store's.
const changeOutcome = (change: Promise<OperationOutcome>): Promise<OperationOutcome> =>
	change.catch((failure: unknown) => {
		if (failure instanceof RefusedWithin) {
			return refused(failure.problem);
		}
		throw failure;
	});

const actorOf = ({ subject, type }: Principal): Actor => ({
	id: subject,
	type,
});

const noInput = (): InputReading<undefined> => ({
	input: undefined,
	kind: 'read',
});

// The event recording one application added to a resource's served set, or removed from it.
const servedResourcesChange = ({
	applicationId,
	change,
	externalId,
	sourceIp,
}: {
	applicationId: string;
	change: 'added' | 'removed';
	externalId: string;
	sourceIp: string;
}): AuditEvent => ({
	data: {
		applicationId,
		change,
		resourceId: externalId,
		result: 'succeeded',
		sourceIp,
	},
	severity: 'info',
	type: 'application.servedResourcesChange',
});

const readerOf = ({ administrator }: Principal, { countedOwner }: ResourceStanding): Reader => {
	if (administrator) {
		return 'administrator';
	}
	return countedOwner ? 'owner' : 'signedIn';
};

/**
 * Creates the routes of the Management API's resource operations: registering a resource, reading
 * one, listing them, and adding or removing one application of a resource's served set.
 *
 * Registering, and changing a served set, are for platform administrators alone. A registration
 * names its access level, and every application it names must be registered, else it is refused 422
 * `unknownApplication` whole. One externalId names one resource in any letter case under ICU's root
 * collation, a retired resource included: a registration of an externalId held already is refused
 * 409 `alreadyExists`, as is the loser of two racing for one. Each owner named by address is
 * resolved through the directory before the transaction begins, as {@link ownerSubjects} resolves
 * them. A registration commits in one transaction with its `resource.registration` event, whose
 * `initialOwnerId` is the subject of the first owner it names, or `null` for none, the served rows,
 * a servedResources notice for each application named, an `application.servedResourcesChange` event
 * for each, and an owner grant on the whole resource for each owner named, in order, as a grant is
 * written: its holder recorded on first meeting them, no expiry, the registering administrator its
 * granter, its holder's acceptance with it under auto-accept, and its `grant.creation` event. A
 * change to a served set refuses 404 `resourceNotFound` or `applicationNotFound` for what the path
 * names and the store does not hold, and commits its row, its notice and its event in one
 * transaction; adding an application serving the resource already, or removing one serving it not,
 * succeeds and writes nothing. A refusal inside a change's transaction rolls it back whole.
 *
 * A read and a listing record no event. A read answers a resource to a principal who may see it: a
 * platform administrator, who sees a retired resource too; a holder of a live grant on it that
 * their latest answer did not reject, its owners among them; and, while it is neither retired nor
 * suppressed, every signed-in principal when its access level is `open` or `registered`. Anyone
 * else is answered 404 `resourceNotFound`, as for one that does not exist. A platform
 * administrator's answer and a counted owner's carry the grant summary, counting each role's
 * holders by their live grants that they accepted; a registration's counts its owners where
 * auto-accept accepts their grants with it. A platform administrator is listed every resource, each
 * entry carrying its unrevoked grants as {@link grantsOnResources} shows them; anyone else is
 * listed the resources they are a counted owner of, each entry as an owner's read shows it, and a
 * principal owning none an empty page. A listing pages in the order of the externalIds in any
 * letter case, retired resources only to an administrator asking for them.
 *
 * @param settings the directory, whether an owner grant written at registration is accepted with
 *   it, the clock, the schema, the trusted issuer, the store and the trail, each on the control
 *   pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createResourceRoutes = (
	{ directory, settings, store, trail }: ResourceOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const { clock, databaseSchema, identityProviderIssuer } = settings;
	const servingChange = (change: 'added' | 'removed'): ManagementOperation<undefined> => ({
		administratorOnly: true,
		body: 'none',
		event: {
			named: ({ params }) =>
				readNamedServing(store, databaseSchema, {
					applicationId: params['applicationId'] ?? '',
					externalId: params['externalId'] ?? '',
				}),
			type: 'application.servedResourcesChange',
		},
		method: change === 'added' ? 'PUT' : 'DELETE',
		readInput: noInput,
		route: '/admin/resources/{externalId}/applications/{applicationId}',
		run: ({ params, principal, sourceIp }) =>
			changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const resource =
						(await findResource(connection, databaseSchema, params['externalId'] ?? '')) ??
						refuseWithin(RESOURCE_PROBLEMS.resourceNotFound);
					const applicationId =
						(await findApplication(connection, databaseSchema, params['applicationId'] ?? '')) ??
						refuseWithin(RESOURCE_PROBLEMS.applicationNotFound);
					const changed =
						change === 'added'
							? (
									await serveResource(connection, databaseSchema, {
										applicationIds: [applicationId],
										resourceId: resource.id,
									})
								).length > 0
							: await stopServingResource(connection, databaseSchema, {
									applicationId,
									resourceId: resource.id,
								});
					if (changed) {
						await record(
							servedResourcesChange({
								applicationId,
								change,
								externalId: resource.externalId,
								sourceIp,
							}),
						);
					}
					return answered(204, undefined);
				}),
			),
	});

	const registration: ManagementOperation<Registration> = {
		administratorOnly: true,
		body: 'required',
		event: { named: async () => ({}), type: 'resource.registration' },
		method: 'POST',
		readInput: (body, { principal }) => readRegistration(body, principal.subject),
		route: '/admin/resources',
		run: async ({ input, principal, sourceIp }) => {
			const named = await ownerSubjects(directory, input.owners, principal.subject);
			if (named.kind === 'refused') {
				return named.outcome;
			}
			const owners = named.subjects;
			const now = new Date(clock.now());
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }) => {
					const applicationIds = await registeredApplications(connection, databaseSchema, input.applications);
					const named = new Set(input.applications.map((id) => id.toLowerCase()));
					if (applicationIds.length !== named.size) {
						refuseWithin(RESOURCE_PROBLEMS.unknownApplication);
					}
					const registrant = await findOrRecordPerson(
						connection,
						databaseSchema,
						{ issuer: identityProviderIssuer, subject: principal.subject },
						now,
					);
					const resourceId =
						(await insertResource(connection, databaseSchema, {
							...input,
							registeredAt: now,
							registeredBy: registrant,
						})) ?? refuseWithin(RESOURCE_PROBLEMS.alreadyExists);
					await serveResource(connection, databaseSchema, {
						applicationIds,
						resourceId,
					});
					await record({
						data: {
							initialOwnerId: owners[0] ?? null,
							resourceId: input.externalId,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'info',
						type: 'resource.registration',
					});
					await writeOwnerGrants({
						autoAccept: settings.grantAutoAccept,
						grants: sqlGrantStore(connection, {
							issuer: identityProviderIssuer,
							schema: databaseSchema,
						}),
						granter: { subject: principal.subject, userId: registrant },
						holderSubjects: owners,
						now,
						record,
						resource: { externalId: input.externalId, id: resourceId },
						sourceIp,
					});
					await applicationIds.reduce<Promise<unknown>>(
						(earlier, applicationId) =>
							earlier.then(() =>
								record(
									servedResourcesChange({
										applicationId,
										change: 'added',
										externalId: input.externalId,
										sourceIp,
									}),
								),
							),
						Promise.resolve(),
					);
					return answered(
						201,
						resourceView(
							{
								accessLevel: input.accessLevel,
								applications: applicationIds,
								categories: [],
								description: input.description,
								displayName: input.displayName,
								externalId: input.externalId,
								fields: {},
								// Each owner named is one person, whose grant auto-accept accepts with it.
								grantSummary:
									settings.grantAutoAccept && owners.length > 0 ? { owner: owners.length } : {},
								registeredAt: now,
								registeredBy: principal.subject,
								retired: false,
								suppressed: false,
								updatedAt: now,
							},
							'administrator',
						),
					);
				}),
			);
		},
	};

	const reading: ManagementOperation<undefined> = {
		administratorOnly: false,
		body: 'none',
		method: 'GET',
		readInput: noInput,
		route: '/admin/resources/{externalId}',
		run: async ({ params, principal }) => {
			const resource = await readResource(store, databaseSchema, {
				externalId: params['externalId'] ?? '',
				issuer: identityProviderIssuer,
				now: new Date(clock.now()),
				subject: principal.subject,
			});
			return resource !== undefined &&
				maySee(resource, {
					administrator: principal.administrator,
					asksForRetired: true,
				})
				? answered(200, resourceView(resource, readerOf(principal, resource)))
				: refused(RESOURCE_PROBLEMS.resourceNotFound);
		},
	};

	const listing: ManagementOperation<ListingQuery> = {
		administratorOnly: false,
		body: 'none',
		method: 'GET',
		readInput: (_body, context) => readListingQuery(context),
		route: '/admin/resources',
		run: async ({ input, principal }) => {
			const now = clock.now();
			const read = await readResourcePage(store, databaseSchema, {
				...input,
				issuer: identityProviderIssuer,
				now: new Date(now),
				ownerSubject: principal.administrator ? undefined : principal.subject,
			});
			const { entries, next } = pageOf(read, input.limit, ({ externalId }) => cursorAfter(externalId));
			if (!principal.administrator) {
				return answered(200, {
					next,
					resources: entries.map((resource) => resourceView(resource, 'owner')),
				});
			}
			const listed = await grantsOnResources(
				{
					directory,
					issuer: identityProviderIssuer,
					schema: databaseSchema,
					store,
				},
				{ now, resourceIds: entries.map(({ id }) => id) },
			);
			return listed.kind === 'unavailable'
				? listed.outcome
				: answered(200, {
						next,
						resources: entries.map((resource) =>
							resourceView(resource, 'administrator', listed.grantsOf(resource.id)),
						),
					});
		},
		takesQuery: true,
	};

	return [
		managementRoute(registration, dependencies),
		managementRoute(listing, dependencies),
		managementRoute(reading, dependencies),
		managementRoute(servingChange('added'), dependencies),
		managementRoute(servingChange('removed'), dependencies),
	];
};
