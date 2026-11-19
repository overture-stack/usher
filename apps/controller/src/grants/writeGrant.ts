import type { AuditEvent } from '../eventLog/index.js';
import type { GrantStore, StoredRole, ViewedGrant } from './types.js';

/** One grant to write, as its creation names it once every rule of it is judged. */
export interface GrantToWrite {
  /** Whether the holder's acceptance is recorded with it. */
  autoAccept: boolean;

  /** Its record category, by id and as a payload names it; `null` for the whole resource. */
  category: { id: string; scopedName: string } | null;

  /** None for a grant that never expires. */
  expiresAt: Date | null;

  /** The configured clock's instant, when it is granted. */
  grantedAt: Date;

  /** The granter: their person and their subject. */
  granter: { subject: string; userId: string };

  /** The holder's subject under the trusted issuer. */
  holderSubject: string;

  /** Its resource, by id and by externalId. */
  resource: { externalId: string; id: string };

  role: StoredRole;

  /** The address the request came from. */
  sourceIp: string;
}

/**
 * Writes one grant in a change's transaction: finds its holder's person, recording them and their
 * identity on first meeting them; ends the grant on its terms that has expired, if one has; writes
 * the grant, unless its holder holds one on its terms that is neither revoked nor ended; with
 * auto-accept, appends its holder's acceptance, showing what its role confers then; and records its
 * `grant.creation`, naming the actor's subject through the transaction, the holder's subject, the
 * resource's externalId, the category as a payload names it, `null` for the whole resource, the
 * role and the grant's id.
 *
 * @param store the grant store, on the change's connection.
 * @param record records an event in the change's transaction.
 * @param grant what to write.
 * @returns the grant as written, or `undefined` when its holder holds one on its terms already.
 */
export const writeGrant = async (
  store: GrantStore,
  record: (event: AuditEvent) => Promise<string>,
  {
    autoAccept,
    category,
    expiresAt,
    grantedAt,
    granter,
    holderSubject,
    resource,
    role,
    sourceIp,
  }: GrantToWrite,
): Promise<ViewedGrant | undefined> => {
  const holderUserId = await store.findOrRecordPerson(holderSubject, grantedAt);
  const terms = {
    holderUserId,
    recordCategoryId: category?.id ?? null,
    resourceId: resource.id,
    roleId: role.id,
  };
  await store.endExpiredGrant(terms, grantedAt);
  const id = await store.insertGrant({
    ...terms,
    expiresAt,
    grantedAt,
    grantedBy: granter.userId,
  });
  if (id === undefined) {
    return undefined;
  }
  const decision = autoAccept
    ? {
        capabilities: role.capabilities,
        decidedAt: await store.appendDecision({
          capabilities: role.capabilities,
          decision: 'accepted',
          grantId: id,
          now: grantedAt,
          userId: holderUserId,
        }),
        decision: 'accepted' as const,
      }
    : null;
  await record({
    data: {
      category: category?.scopedName ?? null,
      grantId: id,
      granteeId: holderSubject,
      resourceId: resource.externalId,
      result: 'succeeded',
      role: role.name,
      sourceIp,
    },
    severity: 'info',
    type: 'grant.creation',
  });
  return {
    category: category?.scopedName ?? null,
    decision,
    endedAt: null,
    expiresAt,
    grantedAt,
    granterSubject: granter.subject,
    holderSubject,
    id,
    resource: resource.externalId,
    revokedAt: null,
    revokerSubject: null,
    role: role.name,
    selfGrant: false,
  };
};
