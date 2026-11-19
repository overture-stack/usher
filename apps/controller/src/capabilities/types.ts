/**
 * Where a capability acts: on the records of an ushered application, `data`, or on rows of Usher's own
 * store, `control`. A role carries capabilities of its own plane alone.
 */
export type Plane = 'control' | 'data';

/** One capability of the vocabulary, its plane the plane of its entity. */
export interface Capability {
	action: string;
	entity: string;

	/** The capability as roles and grants name it: `entity.action`. */
	name: string;

	plane: Plane;
}

/** The name of a role the Controller seeds, as the seeded matrix names it. */
export type SeededRoleName = 'admin' | 'curator' | 'editor' | 'owner' | 'submitter' | 'viewer';

/** A role the Controller seeds: its plane, and every capability it carries as `entity.action` names, sorted. */
export interface SeededRole {
	capabilities: readonly string[];
	plane: Plane;
}
