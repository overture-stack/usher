import type { RouteOptions } from 'fastify';

import {
	type InputReading,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	PROBLEMS,
} from '../managementApi/index.js';

/** An operation the contract lists that the Controller does not carry out yet. */
export interface PlannedOperation {
	/** Whether the contract keeps it for platform administrators alone, refusing everyone else before any lookup. */
	administratorOnly: boolean;

	/** Whether the contract gives it a request body. */
	body: boolean;

	/** Its method, as the contract names it. */
	method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

	/** Its route's template, its parameters in braces, as the contract writes it. */
	route: string;
}

/**
 * The operations the contract lists and marks planned, ordered by route then method: the audit log's
 * read, the EGO import, the resource fields, a resource's deletion, update, restoration, retirement,
 * revocation and suppression, and a role's capabilities.
 */
export const PLANNED_OPERATIONS: readonly PlannedOperation[] = Object.freeze([
	{ administratorOnly: true, body: false, method: 'GET', route: '/admin/audit' },
	{ administratorOnly: true, body: true, method: 'POST', route: '/admin/imports/ego' },
	{ administratorOnly: false, body: false, method: 'GET', route: '/admin/resource-fields' },
	{ administratorOnly: true, body: true, method: 'POST', route: '/admin/resource-fields' },
	{ administratorOnly: true, body: false, method: 'DELETE', route: '/admin/resources/{externalId}' },
	{ administratorOnly: false, body: true, method: 'PATCH', route: '/admin/resources/{externalId}' },
	{ administratorOnly: false, body: true, method: 'POST', route: '/admin/resources/{externalId}/restoration' },
	{ administratorOnly: true, body: false, method: 'POST', route: '/admin/resources/{externalId}/retirement' },
	{ administratorOnly: true, body: true, method: 'POST', route: '/admin/resources/{externalId}/revocations' },
	{ administratorOnly: false, body: true, method: 'POST', route: '/admin/resources/{externalId}/suppression' },
	{ administratorOnly: true, body: true, method: 'PUT', route: '/admin/roles/{roleName}/capabilities' },
]);

const noInput = (): InputReading<undefined> => ({ input: undefined, kind: 'read' });

/**
 * Creates the route of each planned operation. Each admits its caller exactly as a built operation does,
 * a refused credential 401, a service account and every principal before Usher's first administrator
 * 403, and one for administrators alone refusing anyone else 403 `administratorOnly`, then answers 501
 * `notImplemented` and records nothing. A body, where the contract gives the operation one, is read as
 * every operation reads its body and not judged further; query parameters are not judged.
 *
 * @param dependencies what every Management API operation's route is built on.
 */
export const createPlannedOperationRoutes = (dependencies: ManagementDependencies): readonly RouteOptions[] =>
	PLANNED_OPERATIONS.map(({ administratorOnly, body, method, route }) => {
		const operation: ManagementOperation<undefined> = {
			administratorOnly,
			body: body ? 'optional' : 'none',
			method,
			readInput: noInput,
			route,
			run: async () => ({ kind: 'unavailable', problem: PROBLEMS.notImplemented }),
			takesQuery: method === 'GET',
		};
		return managementRoute(operation, dependencies);
	});
