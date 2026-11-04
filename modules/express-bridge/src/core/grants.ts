import type {
  CategoryPermissions,
  PermissionsPayload,
} from '@overture-stack/usher-types';

/**
 * One grant: its resource, category, entity, any field category and action, and for a record grant
 * whether its entry is partitioned by field. Encoded as a JSON list, so an identifier holding a
 * separator never reads as two.
 */
type Grant = string;

const grantsOfEntry = (
  resource: string,
  category: string,
  entry: CategoryPermissions,
): readonly Grant[] => [
  ...(['artifact', 'revision'] as const).flatMap((entity) =>
    (entry[entity] ?? []).map((action) =>
      JSON.stringify([resource, category, entity, action]),
    ),
  ),
  ...(entry.record ?? []).map((action) =>
    JSON.stringify([
      resource,
      category,
      'record',
      action,
      Object.hasOwn(entry, 'field') ? 'byField' : 'whole',
    ]),
  ),
  ...Object.entries(entry.field ?? {}).flatMap(([fieldCategory, actions]) =>
    actions.map((action) =>
      JSON.stringify([resource, category, 'field', fieldCategory, action]),
    ),
  ),
];

/**
 * Every grant named by a payload. Record view on an entry partitioned by field never matches
 * whole-record view, since such an entry reaches no whole record in version 1.
 *
 * @param permissions a validated payload's permissions.
 */
export const grantSet = (
  permissions: PermissionsPayload['permissions'],
): ReadonlySet<Grant> =>
  new Set(
    Object.entries(permissions).flatMap(([resource, entries]) =>
      Object.entries(entries).flatMap(([category, entry]) =>
        grantsOfEntry(resource, category, entry),
      ),
    ),
  );

/**
 * Whether the principal holds only the open tier: every grant in the principal's payload also
 * appears in the anonymous payload. It describes the principal from the two payloads alone, never
 * from what rendering withheld, so it cannot serve as an existence oracle. With no anonymous grant
 * set to compare with, it is false.
 *
 * @param payload the principal's validated payload.
 * @param anonymousGrants the anonymous payload's grant set, from {@link grantSet}, or `undefined`
 *   when no anonymous payload is held.
 */
export const holdsOnlyOpenTier = (
  payload: PermissionsPayload,
  anonymousGrants: ReadonlySet<Grant> | undefined,
): boolean =>
  anonymousGrants !== undefined &&
  [...grantSet(payload.permissions)].every((grant) =>
    anonymousGrants.has(grant),
  );
