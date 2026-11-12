import type { RouteOptions } from 'fastify';

import { findApplication } from '../applications/index.js';
import type { Actor, AuditEvent, JsonValue } from '../eventLog/index.js';
import { findOrRecordPerson } from '../findOrRecordPerson.js';
import type { Problem } from '../http/index.js';
import {
  type InputReading,
  type ManagementDependencies,
  type ManagementOperation,
  managementRoute,
  type OperationOutcome,
  type Principal,
} from '../managementApi/index.js';
import { cursorAfter, readListingQuery } from './listingQuery.js';
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
import type {
  ListingQuery,
  Reader,
  Registration,
  ResourceOperationsSettings,
} from './types.js';

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

const refused = (problem: Problem): OperationOutcome => ({
  kind: 'refused',
  problem,
});

const answered = (
  status: number,
  body: JsonValue | undefined,
): OperationOutcome => ({
  body,
  forbidsStoring: false,
  kind: 'answered',
  status,
});

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it
// written. Any other failure is thrown on, as the store's.
const changeOutcome = (
  change: Promise<OperationOutcome>,
): Promise<OperationOutcome> =>
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

const readerOf = ({ administrator }: Principal): Reader =>
  administrator ? 'administrator' : 'signedIn';

/**
 * Creates the routes of the Management API's resource operations: registering a resource, reading
 * one, listing them, and adding or removing one application of a resource's served set.
 *
 * Registering, and changing a served set, are for platform administrators alone. A registration
 * names its access level, and every application it names must be registered, else it is refused 422
 * `unknownApplication` whole. One externalId names one resource in any letter case under ICU's root
 * collation, a retired resource included: a registration of an externalId held already is refused
 * 409 `alreadyExists`, as is the loser of two racing for one. A registration commits in one
 * transaction with its `resource.registration` event, whose `initialOwnerId` is `null` since a
 * registration names no owner, the served rows, a servedResources notice for each application named,
 * and an `application.servedResourcesChange` event for each. A change to a served set refuses 404
 * `resourceNotFound` or `applicationNotFound` for what the path names and the store does not hold,
 * and commits its row, its notice and its event in one transaction; adding an application serving
 * the resource already, or removing one serving it not, succeeds and writes nothing. A refusal
 * inside a change's transaction rolls it back whole.
 *
 * A read and a listing record no event. A platform administrator reads and lists every resource; any
 * other principal reads one whose access level is `open` or `registered`, neither retired nor
 * suppressed, and is answered 404 `resourceNotFound` for any other, as for one that does not exist,
 * and is listed an empty page, since no operation writes the owner grant that lists a resource to
 * them. A listing pages in the order of the externalIds in any letter case, retired resources only to
 * an administrator asking for them.
 *
 * @param settings the clock, the schema, the trusted issuer, the store and the trail, each on the
 *   control pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createResourceRoutes = (
  {
    settings: { clock, databaseSchema, identityProviderIssuer },
    store,
    trail,
  }: ResourceOperationsSettings,
  dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
  const servingChange = (
    change: 'added' | 'removed',
  ): ManagementOperation<undefined> => ({
    administratorOnly: true,
    body: 'none',
    event: {
      named: (params) =>
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
        trail.inTransaction(
          actorOf(principal),
          async ({ connection, record }): Promise<OperationOutcome> => {
            const resource =
              (await findResource(
                connection,
                databaseSchema,
                params['externalId'] ?? '',
              )) ?? refuseWithin(RESOURCE_PROBLEMS.resourceNotFound);
            const applicationId =
              (await findApplication(
                connection,
                databaseSchema,
                params['applicationId'] ?? '',
              )) ?? refuseWithin(RESOURCE_PROBLEMS.applicationNotFound);
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
          },
        ),
      ),
  });

  const registration: ManagementOperation<Registration> = {
    administratorOnly: true,
    body: 'required',
    event: { named: async () => ({}), type: 'resource.registration' },
    method: 'POST',
    readInput: readRegistration,
    route: '/admin/resources',
    run: async ({ input, principal, sourceIp }) => {
      const now = new Date(clock.now());
      return changeOutcome(
        trail.inTransaction(
          actorOf(principal),
          async ({ connection, record }) => {
            const applicationIds = await registeredApplications(
              connection,
              databaseSchema,
              input.applications,
            );
            const named = new Set(
              input.applications.map((id) => id.toLowerCase()),
            );
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
                initialOwnerId: null,
                resourceId: input.externalId,
                result: 'succeeded',
                sourceIp,
              },
              severity: 'info',
              type: 'resource.registration',
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
                  registeredAt: now,
                  registeredBy: principal.subject,
                  retired: false,
                  suppressed: false,
                  updatedAt: now,
                },
                'administrator',
              ),
            );
          },
        ),
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
      const reader = readerOf(principal);
      const resource = await readResource(
        store,
        databaseSchema,
        identityProviderIssuer,
        { externalId: params['externalId'] ?? '', reader },
      );
      return resource === undefined
        ? refused(RESOURCE_PROBLEMS.resourceNotFound)
        : answered(200, resourceView(resource, reader));
    },
  };

  const listing: ManagementOperation<ListingQuery> = {
    administratorOnly: false,
    body: 'none',
    method: 'GET',
    readInput: (_body, context) => readListingQuery(context),
    route: '/admin/resources',
    run: async ({ input, principal }) => {
      if (!principal.administrator) {
        return answered(200, { next: null, resources: [] });
      }
      const read = await readResourcePage(
        store,
        databaseSchema,
        identityProviderIssuer,
        input,
      );
      const page = read.slice(0, input.limit);
      const last = page.at(-1);
      return answered(200, {
        next:
          read.length > page.length && last !== undefined
            ? cursorAfter(last.externalId)
            : null,
        resources: page.map((resource) =>
          resourceView(resource, 'administrator'),
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
