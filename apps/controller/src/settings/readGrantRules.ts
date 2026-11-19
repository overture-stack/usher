import type {
	GrantRuleRecipient,
	GrantRule,
	GrantRuleAction,
	GrantRuleCategory,
	GrantRuleResource,
	GrantRules,
	SettingReading,
} from './types.js';

type Refused = { kind: 'refused'; rule: string };

const read = <Value>(value: Value): SettingReading<Value> => ({ kind: 'read', value });

const refuse = (rule: string): Refused => ({ kind: 'refused', rule });

const UNMARKED = 'global.unmarked';

const ACTIONS: readonly GrantRuleAction[] = ['count', 'view', 'export'];

const READ_EVERYWHERE: readonly GrantRuleCategory[] = [{ actions: ACTIONS, name: UNMARKED }];

/**
 * The grant rules an instance holds before an admin changes them: everyone reads open resources, and
 * everyone signed in reads open and registered ones, each in count, view and export.
 */
export const DEFAULT_GRANT_RULES: GrantRules = [
	{
		resources: [{ accessLevel: 'open', categories: READ_EVERYWHERE }],
		to: 'everyone',
	},
	{
		resources: [
			{ accessLevel: 'open', categories: READ_EVERYWHERE },
			{ accessLevel: 'registered', categories: READ_EVERYWHERE },
		],
		to: 'signedIn',
	},
];

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const RECIPIENTS: readonly string[] = ['everyone', 'signedIn'];
const ACCESS_LEVELS: readonly string[] = ['open', 'registered'];
const ACTION_NAMES: readonly string[] = ACTIONS;

const isRecipient = (value: unknown): value is GrantRuleRecipient =>
	typeof value === 'string' && RECIPIENTS.includes(value);

const isAccessLevel = (value: unknown): value is GrantRuleResource['accessLevel'] =>
	typeof value === 'string' && ACCESS_LEVELS.includes(value);

const isAction = (value: unknown): value is GrantRuleAction =>
	typeof value === 'string' && ACTION_NAMES.includes(value);

const duplicated = <Item>(items: readonly Item[], keyOf: (item: Item) => unknown): boolean =>
	new Set(items.map(keyOf)).size !== items.length;

// Each object holds exactly the members it takes: every one required, and no other.
const readMembers = (
	value: unknown,
	takes: readonly string[],
	notAnObject: string,
): SettingReading<Readonly<Record<string, unknown>>> => {
	if (!isObject(value)) {
		return refuse(notAnObject);
	}
	if (!Object.keys(value).every((name) => takes.includes(name))) {
		return refuse(`holds a member other than ${takes.join(' and ')}`);
	}
	const missing = takes.find((name) => !Object.hasOwn(value, name));
	return missing === undefined ? read(value) : refuse(`lacks the member ${missing}`);
};

const readAll = <Item>(readings: readonly SettingReading<Item>[]): SettingReading<readonly Item[]> => {
	const refusal = readings.find((reading): reading is Refused => reading.kind === 'refused');
	return refusal ?? read(readings.flatMap((reading) => (reading.kind === 'read' ? [reading.value] : [])));
};

const readList = <Item>(
	value: unknown,
	notAList: string,
	readItem: (item: unknown) => SettingReading<Item>,
): SettingReading<readonly Item[]> => (Array.isArray(value) ? readAll(value.map(readItem)) : refuse(notAList));

const readActions = (value: unknown): SettingReading<readonly GrantRuleAction[]> => {
	const actions = readList(value, 'actions is not a list', (action) =>
		isAction(action) ? read(action) : refuse('actions holds an action other than count, view and export'),
	);
	if (actions.kind === 'refused') {
		return actions;
	}
	return duplicated(actions.value, (action) => action) ? refuse('names an action twice') : actions;
};

const readCategory = (value: unknown): SettingReading<GrantRuleCategory> => {
	const members = readMembers(value, ['actions', 'name'], 'holds a category that is not an object');
	if (members.kind === 'refused') {
		return members;
	}
	const { actions, name } = members.value;
	if (name !== UNMARKED) {
		return refuse('name is not global.unmarked, the only category accepted for now');
	}
	const readActionList = readActions(actions);
	return readActionList.kind === 'read' ? read({ actions: readActionList.value, name: UNMARKED }) : readActionList;
};

const readCategories = (value: unknown): SettingReading<readonly GrantRuleCategory[]> => {
	const categories = readList(value, 'categories is not a list', readCategory);
	if (categories.kind === 'refused') {
		return categories;
	}
	return duplicated(categories.value, (category) => category.name) ? refuse('names a category twice') : categories;
};

const readResource = (value: unknown): SettingReading<GrantRuleResource> => {
	const members = readMembers(value, ['accessLevel', 'categories'], 'holds a resource that is not an object');
	if (members.kind === 'refused') {
		return members;
	}
	const { accessLevel, categories } = members.value;
	if (!isAccessLevel(accessLevel)) {
		return refuse('accessLevel is not open or registered');
	}
	const readCategoryList = readCategories(categories);
	return readCategoryList.kind === 'read'
		? read({ accessLevel, categories: readCategoryList.value })
		: readCategoryList;
};

const readResources = (value: unknown): SettingReading<readonly GrantRuleResource[]> => {
	const resources = readList(value, 'resources is not a list', readResource);
	if (resources.kind === 'refused') {
		return resources;
	}
	return duplicated(resources.value, (resource) => resource.accessLevel)
		? refuse('names an accessLevel twice')
		: resources;
};

const readEntry = (value: unknown): SettingReading<GrantRule> => {
	const members = readMembers(value, ['resources', 'to'], 'holds an entry that is not an object');
	if (members.kind === 'refused') {
		return members;
	}
	const { resources, to } = members.value;
	if (!isRecipient(to)) {
		return refuse('holds an entry whose to is neither everyone nor signedIn');
	}
	const readResourceList = readResources(resources);
	return readResourceList.kind === 'read' ? read({ resources: readResourceList.value, to }) : readResourceList;
};

/**
 * Reads the grant rules a seed file, the Management API or the store gives: a list of entries, each
 * for one recipient, every member required and no other taken. A recipient is named by at most one
 * entry, an access level by at most one resource, a category by at most one category and an action by
 * at most one place in its category, and every plural member is a list, empty included. Only
 * `global.unmarked` is accepted as a category, and its actions are drawn from count, view and export, never
 * more. The order of members is not judged.
 *
 * @param value the value as the source gives it, before any reading.
 */
export const readGrantRules = (value: unknown): SettingReading<GrantRules> => {
	const entries = readList(value, 'is not a list of entries', readEntry);
	if (entries.kind === 'refused') {
		return entries;
	}
	return duplicated(entries.value, (entry) => entry.to) ? refuse('names a recipient twice') : entries;
};
