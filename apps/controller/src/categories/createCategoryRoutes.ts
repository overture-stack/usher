import type { RouteOptions } from 'fastify';

import { isConcreteGlobalCategory } from '@overture-stack/usher-types';

import { type Actor, type JsonValue } from '../eventLog/index.js';
import type { Problem } from '../http/index.js';
import {
	type EventMembers,
	type InputReading,
	type ManagementDependencies,
	type ManagementOperation,
	managementRoute,
	type NamedByRequest,
	type OperationOutcome,
	type Principal,
	unreadableBody,
} from '../managementApi/index.js';
import { CATEGORY_PROBLEMS, categoryAlreadyExists } from './categoryProblems.js';
import { isCountedOwner, listGlobalCategories } from './categoryStore.js';
import type { CategoryOperationsSettings, CategoryRegistration, CategoryUpdate, CategoryView } from './types.js';

// A name as a registration may give it: letters, digits, underscores and hyphens, and nothing that a scope
// separator or a path would make ambiguous.
const NAME_FORM = /^[A-Za-z0-9_-]+$/u;

const GLOBAL_SCOPE = 'global.';

// A change's refusal reached inside its transaction, thrown so the transaction rolls back and nothing of the
// change is written.
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

const answered = (status: number, body: JsonValue): OperationOutcome => ({
	body,
	forbidsStoring: false,
	kind: 'answered',
	status,
});

// A change's outcome: what it answered once committed, or the refusal it reached, nothing of it written. Any other
// failure is thrown on, as the store's.
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

const scopedOf = (name: string): string => `${GLOBAL_SCOPE}${name}`;

// The bare name a scoped name names, or `undefined` when it carries another scope or none.
const bareOf = (scopedName: string): string | undefined =>
	scopedName.startsWith(GLOBAL_SCOPE) ? scopedName.slice(GLOBAL_SCOPE.length) : undefined;

// The category a refused registration or update names, recorded beside its refusal when the name is one the scope
// could take: the caller's text is never recorded as it was sent.
const namedRegistration = async ({ body }: NamedByRequest): Promise<EventMembers> => {
	const name = body?.['name'];
	return typeof name === 'string' && NAME_FORM.test(name) ? { category: scopedOf(name) } : {};
};

const namedUpdate = async ({ params }: NamedByRequest): Promise<EventMembers> => {
	const name = bareOf(params['scopedName'] ?? '');
	return name !== undefined && NAME_FORM.test(name) ? { category: scopedOf(name) } : {};
};

const categoryView = (name: string, description: string | null): CategoryView => ({ description, name });

const noInput = (): InputReading<undefined> => ({ input: undefined, kind: 'read' });

const refusedReading = <Input>(rule: string): InputReading<Input> => ({
	kind: 'refused',
	problem: unreadableBody(rule),
});

// A registration's body, read strictly: `name`, a string, and `description`, a string if sent. A name the scope
// cannot take is refused 422 once its shape is read.
const readRegistration = (body: Readonly<Record<string, unknown>> | undefined): InputReading<CategoryRegistration> => {
	const { description, name, ...others } = body ?? {};
	if (Object.keys(others).length > 0) {
		return refusedReading('holds a member this operation does not take: it takes name and description');
	}
	if (name === undefined) {
		return refusedReading('lacks the member name');
	}
	if (typeof name !== 'string') {
		return refusedReading('holds name as something other than a string');
	}
	if (description !== undefined && typeof description !== 'string') {
		return refusedReading('holds description as something other than a string');
	}
	if (!NAME_FORM.test(name) || !isConcreteGlobalCategory(scopedOf(name.toLowerCase()))) {
		return { kind: 'refused', problem: CATEGORY_PROBLEMS.invalidCategoryName };
	}
	return { input: { description: description ?? null, name }, kind: 'read' };
};

// An update's merge patch, read strictly: `description`, a string or `null` when sent. Any other member is refused
// 422, after the description's shape is read as 400.
const readUpdate = (body: Readonly<Record<string, unknown>> | undefined): InputReading<CategoryUpdate> => {
	const { description, ...others } = body ?? {};
	if (description !== undefined && description !== null && typeof description !== 'string') {
		return refusedReading('holds description as something other than a string or null');
	}
	if (Object.keys(others).length > 0) {
		return { kind: 'refused', problem: CATEGORY_PROBLEMS.memberNotSettable };
	}
	return { input: description === undefined ? {} : { description }, kind: 'read' };
};

/**
 * Creates the routes of the Management API's category operations: listing the global categories, registering one,
 * and updating its description. Every operation refuses a service account 403 `serviceAccountNotPermitted`, and
 * refuses everyone while Usher has no administrator, before anything is read.
 *
 * The listing is for platform administrators and for principals who own at least one resource, judged by the
 * store, and records nothing. Registering and updating are for platform administrators alone, refused 403
 * `administratorOnly` before the body is read. A registration's body is read before its name is judged: a shape
 * the body cannot take is 400, a name the scope cannot take is 422, a reserved name included in any letter case,
 * and a name a global category already holds in any letter case is 409 `alreadyExists`, naming that category,
 * judged by the store inside the change's transaction. A registration is recorded as
 * `category.creation` at warning. An update's body is read the same way: a description of another type is 400,
 * a member other than description is 422 `memberNotSettable`, and only then is the scoped name judged, as 404
 * `categoryNotFound` for one no global category holds in any letter case; a category found is answered and
 * recorded under the spelling it was registered in. A patch changing the description commits it and records
 * `category.descriptionChange` at info; one changing nothing writes nothing and records nothing. Each change runs
 * its transaction through the trail, which confirms the administrator still holds the role.
 *
 * @param operations the category store over a transaction's connection, the store reader, the configuration and
 *   the trail each change is made in.
 * @param dependencies what every Management API operation's route is built on.
 */
export const createCategoryRoutes = (
	{
		categoryStoreOf,
		settings: { clock, databaseSchema, identityProviderIssuer },
		store,
		trail,
	}: CategoryOperationsSettings,
	dependencies: ManagementDependencies,
): readonly RouteOptions[] => {
	const listing: ManagementOperation<undefined> = {
		administratorOnly: false,
		body: 'none',
		method: 'GET',
		readInput: noInput,
		route: '/admin/categories',
		run: async ({ principal }) => {
			const allowed =
				principal.administrator ||
				(await isCountedOwner(
					store,
					databaseSchema,
					{ issuer: identityProviderIssuer, subject: principal.subject },
					new Date(clock.now()),
				));
			if (!allowed) {
				return refused(CATEGORY_PROBLEMS.ownersAndAdministratorsOnly);
			}
			return answered(200, { categories: await listGlobalCategories(store, databaseSchema) });
		},
	};

	const registration: ManagementOperation<CategoryRegistration> = {
		administratorOnly: true,
		body: 'required',
		event: { named: namedRegistration, type: 'category.creation' },
		method: 'POST',
		readInput: (body) => readRegistration(body),
		route: '/admin/categories',
		run: async ({ input, principal, sourceIp }) =>
			changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const insertion = await categoryStoreOf(connection).insertGlobal(input);
					if (insertion.kind === 'taken') {
						refuseWithin(categoryAlreadyExists(scopedOf(insertion.existing)));
					}
					await record({
						data: {
							category: scopedOf(input.name),
							description: input.description,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'warning',
						type: 'category.creation',
					});
					return answered(201, categoryView(scopedOf(input.name), input.description));
				}),
			),
	};

	const update: ManagementOperation<CategoryUpdate> = {
		administratorOnly: true,
		body: 'required',
		event: { named: namedUpdate, type: 'category.descriptionChange' },
		method: 'PATCH',
		readInput: (body) => readUpdate(body),
		route: '/admin/categories/{scopedName}',
		run: async ({ input, params, principal, sourceIp }) => {
			const scopedName = params['scopedName'] ?? '';
			return changeOutcome(
				trail.inTransaction(actorOf(principal), async ({ connection, record }): Promise<OperationOutcome> => {
					const asked = bareOf(scopedName) ?? refuseWithin(CATEGORY_PROBLEMS.categoryNotFound);
					const stored =
						(await categoryStoreOf(connection).findGlobal(asked)) ??
						refuseWithin(CATEGORY_PROBLEMS.categoryNotFound);
					const { name } = stored;
					const next = input.description === undefined ? stored.description : input.description;
					if (next === stored.description) {
						return answered(200, categoryView(scopedOf(name), stored.description));
					}
					await categoryStoreOf(connection).setDescription(stored.id, next);
					await record({
						data: {
							category: scopedOf(name),
							descriptionAfter: next,
							descriptionBefore: stored.description,
							result: 'succeeded',
							sourceIp,
						},
						severity: 'info',
						type: 'category.descriptionChange',
					});
					return answered(200, categoryView(scopedOf(name), next));
				}),
			);
		},
	};

	return [
		managementRoute(listing, dependencies),
		managementRoute(registration, dependencies),
		managementRoute(update, dependencies),
	];
};
