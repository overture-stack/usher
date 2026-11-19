import type {
	ArtifactAction,
	ControlEntity,
	DataEntity,
	FieldAction,
	RecordAction,
	RevisionAction,
} from '@overture-stack/usher-types';

import type { Capability, Plane } from './types.js';

// Each data-plane entity's actions as a set keyed by action, so the payload's action types gaining or
// losing one fails to compile here.
const ARTIFACT_ACTIONS = {
	count: true,
	create: true,
	delete: true,
	export: true,
	update: true,
	view: true,
} as const satisfies Record<ArtifactAction, true>;

const FIELD_ACTIONS = {
	count: true,
	export: true,
	update: true,
	view: true,
} as const satisfies Record<FieldAction, true>;

const RECORD_ACTIONS = {
	count: true,
	create: true,
	delete: true,
	export: true,
	update: true,
	view: true,
} as const satisfies Record<RecordAction, true>;

const REVISION_ACTIONS = {
	export: true,
	view: true,
} as const satisfies Record<RevisionAction, true>;

// Exactly the entities a token's category entry may carry.
const DATA_ENTITIES: Readonly<Record<DataEntity, readonly string[]>> = {
	artifact: Object.keys(ARTIFACT_ACTIONS),
	field: Object.keys(FIELD_ACTIONS),
	record: Object.keys(RECORD_ACTIONS),
	revision: Object.keys(REVISION_ACTIONS),
};

// Rows of Usher's own store, which no token carries, so the payload types name none of their actions.
const CONTROL_ENTITIES: Readonly<Record<ControlEntity, readonly string[]>> = {
	category: ['create'],
	custodianship: ['assign', 'remove'],
	grant: ['create', 'extend', 'reduce', 'revoke', 'view'],
	group: ['addMember', 'create', 'removeMember', 'update', 'view'],
	invitation: ['create'],
	ownership: ['transfer'],
	resource: ['register', 'restore', 'suppress', 'update', 'view'],
	role: ['define'],
};

const capabilitiesIn = (plane: Plane, entities: Readonly<Record<string, readonly string[]>>): readonly Capability[] =>
	Object.entries(entities).flatMap(([entity, actions]) =>
		actions.map((action) => Object.freeze({ action, entity, name: `${entity}.${action}`, plane })),
	);

/**
 * Every capability Usher's vocabulary holds, by entity and action: the data plane's entities, exactly
 * the keys a token's category entry may carry, and the control plane's, rows of Usher's own store. The
 * list lives in code rather than in the store, since no entity arrives without code, and each entity's
 * plane is fixed once, by the plane it is listed under, so two capabilities of one entity never
 * disagree about it.
 */
export const CAPABILITY_VOCABULARY: readonly Capability[] = Object.freeze([
	...capabilitiesIn('control', CONTROL_ENTITIES),
	...capabilitiesIn('data', DATA_ENTITIES),
]);
