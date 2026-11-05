import { CAPABILITY_VOCABULARY } from './capabilityVocabulary.js';
import type { Plane, SeededRole, SeededRoleName } from './types.js';

// An entity written with `.*` in the matrix: every action the vocabulary gives it.
const everyActionOf = (entity: string): readonly string[] =>
  CAPABILITY_VOCABULARY.filter(
    (capability) => capability.entity === entity,
  ).map(({ name }) => name);

// The `read` group on a record, expanded as a role naming it is written.
const READ = ['record.count', 'record.export', 'record.view'];

const EDITOR = [...READ, 'record.create', 'record.update'];

const OWNER = [
  ...everyActionOf('grant'),
  'invitation.create',
  'ownership.transfer',
  'resource.restore',
  'resource.suppress',
  'resource.update',
  'resource.view',
];

const seeded = (
  plane: Plane,
  capabilities: readonly string[],
): Readonly<SeededRole> =>
  Object.freeze({
    capabilities: Object.freeze(capabilities.toSorted()),
    plane,
  });

/**
 * The roles the controller seeds, as the seeded matrix gives them. In the data plane, a staircase that
 * nothing walks: `viewer` reads, `editor` also creates and updates, `curator` also deletes, and
 * `submitter`, off the staircase, creates and updates and reads nothing. In the control plane, a
 * checklist: `owner` administers access to one resource, and `admin` holds all of an owner's
 * capabilities and the four platform-wide ones beside them. Neither plane's roles carry the other's
 * capabilities, and no seeded role carries a custodianship capability, since nothing in this release
 * appoints a custodian.
 */
export const SEEDED_ROLES: Readonly<
  Record<SeededRoleName, Readonly<SeededRole>>
> = Object.freeze({
  admin: seeded('control', [
    ...OWNER,
    ...everyActionOf('group'),
    'category.create',
    'resource.register',
    'role.define',
  ]),
  curator: seeded('data', [...EDITOR, 'record.delete']),
  editor: seeded('data', EDITOR),
  owner: seeded('control', OWNER),
  submitter: seeded('data', ['record.create', 'record.update']),
  viewer: seeded('data', READ),
});
