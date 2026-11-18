import type { RouteOptions } from 'fastify';
import pg from 'pg';

import type { Actor, JsonValue } from '../eventLog/index.js';
import { ControllerError } from '../failures/index.js';
import type { Problem } from '../http/index.js';
import {
  type EventMembers,
  type ManagementDependencies,
  type ManagementOperation,
  managementRoute,
  type NamedByRequest,
  type OperationOutcome,
  type Principal,
} from '../managementApi/index.js';
import { isLive } from '../resourceStanding/index.js';
import { grantAuthority } from './grantAuthority.js';
import { GRANT_PROBLEMS } from './grantProblems.js';
import { grantView } from './grantView.js';
import { readGrantAnswer } from './readGrantAnswer.js';
import { readGrantCreation } from './readGrantCreation.js';
import { readGrantRevocation } from './readGrantRevocation.js';
import type {
  GrantAnswer,
  GrantCreation,
  GrantOperationsSettings,
  GrantRevocation,
  StoredGrant,
  StoredRole,
} from './types.js';
import { writeGrant } from './writeGrant.js';

// An id in the form the store gives a grant's; any other text names no grant, and is never sent to
// the store as one.
const GRANT_ID_FORM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A refusal reached inside a change's transaction, thrown so the transaction rolls back and nothing
// of the change is written, a person first met in it included.
class RefusedWithin extends Error {
  readonly problem: Problem;
  readonly recordedReason: string | undefined;

  constructor(problem: Problem, recordedReason?: string) {
    super(problem.code);
    this.problem = problem;
    this.recordedReason = recordedReason;
  }
}

const refuseWithin = (problem: Problem, recordedReason?: string): never => {
  throw new RefusedWithin(problem, recordedReason);
};

const refused = (
  problem: Problem,
  recordedReason?: string,
): OperationOutcome => ({
  kind: 'refused',
  problem,
  ...(recordedReason === undefined ? {} : { recordedReason }),
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

const constraintOf = (failure: unknown): string | undefined => {
  const constraint: unknown =
    typeof failure === 'object' && failure !== null && 'constraint' in failure
      ? failure.constraint
      : undefined;
  return typeof constraint === 'string' ? constraint : undefined;
};

// A change's outcome: what it answered once committed, the refusal it reached, or the refusal a
// rule the store checks at commit answers, nothing of it written. Any other failure is thrown on,
// as the store's.
const changeOutcome = (
  change: Promise<OperationOutcome>,
  refusedAtCommit: Readonly<Record<string, Problem>> = {},
): Promise<OperationOutcome> =>
  change.catch((failure: unknown) => {
    if (failure instanceof RefusedWithin) {
      return refused(failure.problem, failure.recordedReason);
    }
    const constraint = constraintOf(failure);
    const problem =
      constraint === undefined ? undefined : refusedAtCommit[constraint];
    if (problem !== undefined) {
      return refused(problem);
    }
    throw failure;
  });

const roleMissing = (): never => {
  throw new ControllerError("the store holds no role by a grant's role name");
};

const actorOf = ({ subject, type }: Principal): Actor => ({
  id: subject,
  type,
});

// Whether a grant makes its holder a counted owner of its resource now: an owner grant, live, whose
// holder's latest answer accepted it.
const isCountedOwnerGrant = (grant: StoredGrant, now: number): boolean =>
  grant.role === 'owner' &&
  isLive(grant, now) &&
  grant.decision?.decision === 'accepted';

// Whether the capabilities shown are exactly a role's, as a set.
const showsRole = (
  shown: readonly string[],
  { capabilities }: StoredRole,
): boolean => {
  const named = new Set(shown);
  return (
    named.size === capabilities.length &&
    capabilities.every((capability) => named.has(capability))
  );
};

/**
 * Creates the routes of the Management API's grant operations: creating a grant, a holder answering
 * one, and revoking one. Each change commits in one transaction with its event and its notices, or
 * writes nothing; a refusal inside the transaction rolls it back whole, and a service account is
 * refused 403 `serviceAccountNotPermitted` before anything is read. Every instant is read from the
 * configured clock, and a grant is live while it is neither revoked, nor replaced once expired, nor
 * expired on that clock. A retired resource, and every grant on one, is answered as one that does
 * not exist, to everyone. Each change locks the resource's row before any grant's.
 *
 * Creating a grant, `POST /admin/grants`, reads its body with {@link readGrantCreation}, then
 * judges in turn: a role the instance does not define, in its exact letter case, 422 `unknownRole`;
 * a control-plane role naming a category 422 `wholeResourceRole`, and a data-plane role naming none
 * 422 `categoryRequired`, except `submitter`, which takes the instance's submitter category; the
 * grant's authority, decided by {@link grantAuthority} on the resource's row locked for share; a
 * category the resource does not offer 422 `categoryNotOffered`; and a holder named by address, 503
 * `directoryUnavailable`, since no directory is read. It then writes the grant with {@link
 * writeGrant}, its granter the caller, recorded on first meeting them, refusing 409 `alreadyHolds`
 * a holder holding one on its terms neither revoked nor ended, and answers 201 with the grant. A
 * creation whose commit fails since its resource was retired first is answered 404
 * `resourceNotFound`. Its event, refused, names the resource the body names only when the store
 * holds a resource under that externalId, whatever its standing.
 *
 * Answering a grant, `POST /admin/grants/{id}/decisions`, reads its body with {@link
 * readGrantAnswer}. Only the grant's holder answers it, the person holding the caller's identity
 * under the trusted issuer: anyone else, and an id naming no grant held by a person, malformed or
 * not, is answered 404 `grantNotFound` alike. A grant no longer live is refused 409 `doesNotHold`;
 * capabilities other than those the grant's role confers now, as a set, 422 `capabilitiesDiffer`;
 * and declining the last counted owner grant of its resource, 409 `resourceNeedsAnOwner`, as is a
 * decline whose commit fails for keeping its resource owned. The answer is appended, showing the
 * role's capabilities, each later than the holder's latest answer to the grant, and recorded as
 * `grant.decision`; the grant itself is left as it is, and the answer is 204.
 *
 * Revoking a grant, `DELETE /admin/grants/{id}`, reads its body with {@link readGrantRevocation}. A
 * platform administrator revokes any grant, and a counted owner of its resource any grant on it;
 * anyone else, and an id naming no grant held by a person, malformed or empty, is answered 404
 * `grantNotFound` alike. A grant revoked already is refused 409 `doesNotHold`, keeping its first
 * revocation; a pending, declined, accepted or expired grant is revoked alike. Revoking the last
 * counted owner grant of its resource is refused 409 `resourceNeedsAnOwner`, as is a revocation
 * whose commit fails for keeping its resource owned. The revocation records its reason on
 * `grant.revocation` and answers 200 with the grant revoked.
 *
 * A refusal answered `404` for want of authority records `noAuthorityOnResource` as its event's
 * reason; an event of an answer or a revocation refused names the grant when one held by a person
 * has the id.
 *
 * @param operations the grant store over a transaction's connection, the settings, the store reader
 *   and the trail, each on the control pool.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createGrantRoutes = (
  {
    grantStoreOf,
    settings: { autoAccept, clock, databaseSchema, submitterCategory },
    store,
    trail,
  }: GrantOperationsSettings,
  dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
  const namedGrant = async ({
    params,
  }: NamedByRequest): Promise<EventMembers> => {
    const grantId = params['id'] ?? '';
    if (!GRANT_ID_FORM.test(grantId)) {
      return {};
    }
    const { rows } = await store.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.grants
                       WHERE id = $1::uuid AND holder_user_id IS NOT NULL) AS exists`,
      [grantId],
    );
    return rows[0]?.exists === true ? { grantId } : {};
  };

  const namedResource = async ({
    body,
  }: NamedByRequest): Promise<EventMembers> => {
    const resource = body?.['resource'];
    if (typeof resource !== 'string') {
      return {};
    }
    const { rows } = await store.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${pg.escapeIdentifier(databaseSchema)}.resources
                       WHERE external_id = $1) AS exists`,
      [resource],
    );
    return rows[0]?.exists === true ? { resourceId: resource } : {};
  };

  const creation: ManagementOperation<GrantCreation> = {
    administratorOnly: false,
    body: 'required',
    event: { named: namedResource, type: 'grant.creation' },
    method: 'POST',
    readInput: (body) => readGrantCreation(body ?? {}, clock.now()),
    route: '/admin/grants',
    run: ({ input, principal, sourceIp }) => {
      const now = new Date(clock.now());
      return changeOutcome(
        trail.inTransaction(
          actorOf(principal),
          async ({ connection, record }): Promise<OperationOutcome> => {
            const grants = grantStoreOf(connection);
            const role =
              (await grants.findRole(input.role)) ??
              refuseWithin(GRANT_PROBLEMS.unknownRole);
            if (role.plane === 'control' && input.category !== undefined) {
              refuseWithin(GRANT_PROBLEMS.wholeResourceRole);
            }
            const takesSubmitterCategory =
              role.plane === 'data' &&
              input.category === undefined &&
              role.name === 'submitter';
            if (
              role.plane === 'data' &&
              input.category === undefined &&
              !takesSubmitterCategory
            ) {
              refuseWithin(GRANT_PROBLEMS.categoryRequired);
            }
            const scopedName = takesSubmitterCategory
              ? submitterCategory
              : input.category;
            const standing = await grants.readStanding({
              externalId: input.resource,
              lock: 'share',
              now,
              subject: principal.subject,
            });
            const authority = grantAuthority({
              administrator: principal.administrator,
              holderIsCaller:
                input.holder.kind === 'subject' &&
                input.holder.subject === principal.subject,
              role: role.name,
              standing,
            });
            if (authority.kind === 'refuse') {
              refuseWithin(authority.problem, authority.recordedReason);
            }
            const resource =
              standing ?? refuseWithin(GRANT_PROBLEMS.resourceNotFound);
            const category =
              scopedName === undefined
                ? null
                : {
                    id:
                      (await grants.findOfferedCategory(
                        scopedName,
                        resource.id,
                      )) ??
                      refuseWithin(
                        takesSubmitterCategory
                          ? GRANT_PROBLEMS.submitterCategoryNotOffered
                          : GRANT_PROBLEMS.categoryNotOffered,
                      ),
                    scopedName,
                  };
            const holderSubject =
              input.holder.kind === 'subject'
                ? input.holder.subject
                : refuseWithin(GRANT_PROBLEMS.directoryUnavailable);
            const granter = {
              subject: principal.subject,
              userId: await grants.findOrRecordPerson(principal.subject, now),
            };
            const written =
              (await writeGrant(grants, record, {
                autoAccept,
                category,
                expiresAt: input.expiresAt ?? null,
                grantedAt: now,
                granter,
                holderSubject,
                resource: { externalId: resource.externalId, id: resource.id },
                role,
                sourceIp,
              })) ?? refuseWithin(GRANT_PROBLEMS.alreadyHolds);
            return answered(201, grantView(written, now.getTime()));
          },
        ),
        {
          resources_retired_without_live_grants:
            GRANT_PROBLEMS.resourceNotFound,
        },
      );
    },
  };

  const answering: ManagementOperation<GrantAnswer> = {
    administratorOnly: false,
    body: 'required',
    event: { named: namedGrant, type: 'grant.decision' },
    method: 'POST',
    readInput: (body) => readGrantAnswer(body ?? {}),
    route: '/admin/grants/{id}/decisions',
    run: async ({ input, params, principal, sourceIp }) => {
      const grantId = params['id'] ?? '';
      if (!GRANT_ID_FORM.test(grantId)) {
        return refused(GRANT_PROBLEMS.grantNotFound);
      }
      const now = new Date(clock.now());
      return changeOutcome(
        trail.inTransaction(
          actorOf(principal),
          async ({ connection, record }): Promise<OperationOutcome> => {
            const grants = grantStoreOf(connection);
            const located =
              (await grants.locateGrant(grantId)) ??
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            await grants.lockResource(located.resourceId);
            const grant =
              (await grants.readGrant(grantId)) ??
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            if (grant.resourceRetired) {
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            }
            if (
              (await grants.findPerson(principal.subject)) !==
              grant.holderUserId
            ) {
              refuseWithin(
                GRANT_PROBLEMS.grantNotFound,
                GRANT_PROBLEMS.noAuthorityOnResource.code,
              );
            }
            if (!isLive(grant, now.getTime())) {
              refuseWithin(GRANT_PROBLEMS.doesNotHold);
            }
            const role = (await grants.findRole(grant.role)) ?? roleMissing();
            if (!showsRole(input.capabilities, role)) {
              refuseWithin(GRANT_PROBLEMS.capabilitiesDiffer);
            }
            if (
              input.decision === 'rejected' &&
              isCountedOwnerGrant(grant, now.getTime()) &&
              (await grants.countedOwnersBesides({
                grantId,
                now,
                resourceId: grant.resourceId,
              })) === 0
            ) {
              refuseWithin(GRANT_PROBLEMS.resourceNeedsAnOwner);
            }
            await grants.appendDecision({
              capabilities: role.capabilities,
              decision: input.decision,
              grantId,
              now,
              userId: grant.holderUserId,
            });
            await record({
              data: {
                category: grant.category,
                decision: input.decision,
                grantId,
                resourceId: grant.resource,
                result: 'succeeded',
                role: grant.role,
                sourceIp,
              },
              severity: 'info',
              type: 'grant.decision',
            });
            return answered(204, undefined);
          },
        ),
        { resources_keep_an_owner: GRANT_PROBLEMS.resourceNeedsAnOwner },
      );
    },
  };

  const revocation: ManagementOperation<GrantRevocation> = {
    administratorOnly: false,
    body: 'optional',
    event: { named: namedGrant, type: 'grant.revocation' },
    method: 'DELETE',
    readInput: readGrantRevocation,
    route: '/admin/grants/{id}',
    run: async ({ input, params, principal, sourceIp }) => {
      const grantId = params['id'] ?? '';
      if (!GRANT_ID_FORM.test(grantId)) {
        return refused(GRANT_PROBLEMS.grantNotFound);
      }
      const now = new Date(clock.now());
      return changeOutcome(
        trail.inTransaction(
          actorOf(principal),
          async ({ connection, record }): Promise<OperationOutcome> => {
            const grants = grantStoreOf(connection);
            const located =
              (await grants.locateGrant(grantId)) ??
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            const standing = await grants.readStanding({
              externalId: located.externalId,
              lock: 'noKeyUpdate',
              now,
              subject: principal.subject,
            });
            if (standing === undefined || standing.retired) {
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            }
            if (!principal.administrator && standing?.countedOwner !== true) {
              refuseWithin(
                GRANT_PROBLEMS.grantNotFound,
                GRANT_PROBLEMS.noAuthorityOnResource.code,
              );
            }
            const grant =
              (await grants.readGrant(grantId)) ??
              refuseWithin(GRANT_PROBLEMS.grantNotFound);
            if (grant.revokedAt !== null) {
              refuseWithin(GRANT_PROBLEMS.alreadyRevoked);
            }
            if (
              isCountedOwnerGrant(grant, now.getTime()) &&
              (await grants.countedOwnersBesides({
                grantId,
                now,
                resourceId: grant.resourceId,
              })) === 0
            ) {
              refuseWithin(GRANT_PROBLEMS.resourceNeedsAnOwner);
            }
            await grants.revokeGrant({
              grantId,
              now,
              revokedBy: await grants.findOrRecordPerson(
                principal.subject,
                now,
              ),
            });
            await record({
              data: {
                category: grant.category,
                grantId,
                granteeId: grant.holderSubject,
                reason: input.reason,
                resourceId: grant.resource,
                result: 'succeeded',
                role: grant.role,
                sourceIp,
              },
              severity: 'info',
              type: 'grant.revocation',
            });
            return answered(
              200,
              grantView(
                { ...grant, revokedAt: now, revokerSubject: principal.subject },
                now.getTime(),
              ),
            );
          },
        ),
        { resources_keep_an_owner: GRANT_PROBLEMS.resourceNeedsAnOwner },
      );
    },
  };

  return [
    managementRoute(creation, dependencies),
    managementRoute(answering, dependencies),
    managementRoute(revocation, dependencies),
  ];
};
