import { dirname, join, normalize } from 'node:path';

/**
 * Where a section stands, as the list records it: `built` and tested here; `partial`, its main rule
 * built and tested, with a part still to build; `external`, built and tested in another repository;
 * `untested`, built with no test yet; `planned`; `open`, an unsettled question; and `context`, a
 * section stating no rule.
 */
export type SectionStatus = 'built' | 'context' | 'external' | 'open' | 'partial' | 'planned' | 'untested';

/** One reason the list does not stand, named by the rule it breaks. */
export interface TraceabilityFinding {
	message: string;
	rule:
		| 'builtWithoutTest'
		| 'duplicateRow'
		| 'externalWithoutTest'
		| 'missingList'
		| 'missingRow'
		| 'staleRow'
		| 'unknownStatus'
		| 'unresolvedLink'
		| 'untrackedStatus';
}

/** What the check reads: the design files in scope, the list's path, and each file's text by path. */
export interface Workspace {
	/** Repository-relative paths of the design files whose sections need a row. */
	designFiles: readonly string[];

	/** The list's repository-relative path. */
	list: string;

	/** A file's text by its repository-relative path; `undefined` for one that does not exist. */
	read: (path: string) => string | undefined;
}

/** A section a design file states: a leaf heading and the anchor GitHub gives it. */
export interface DesignSection {
	slug: string;
	text: string;
}

const STATUSES: ReadonlySet<string> = new Set([
	'built',
	'context',
	'external',
	'open',
	'partial',
	'planned',
	'untested',
]);

const ROADMAP = '.dev/roadmap.md';

// The files a status's tracking link may point into, by status: an open question wherever it is
// already held, and anything still to build in the roadmap.
const TRACKED_IN: Readonly<Partial<Record<SectionStatus, readonly string[]>>> = {
	open: [ROADMAP, '.dev/design/to-discuss.md'],
	partial: [ROADMAP],
	planned: [ROADMAP],
	untested: [ROADMAP],
};

// The statuses whose test is linked in this repository.
const TESTED_HERE: ReadonlySet<string> = new Set(['built', 'partial']);

const isWebLink = (link: string): boolean => /^https?:\/\//u.test(link);

const FENCE = /^\s*(```|~~~)/u;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/gu;

// A heading's text as GitHub reads it for its anchor: links by their text, and no emphasis or code marks.
const plainText = (text: string): string => text.replace(LINK, '$1');

const slugOf = (text: string): string =>
	plainText(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /gu, '-');

// Every heading outside code blocks, with its level, in order.
const headingsOf = (markdown: string): readonly { level: number; text: string }[] =>
	markdown.split('\n').reduce<{ fenced: boolean; headings: { level: number; text: string }[] }>(
		({ fenced, headings }, line) => {
			if (FENCE.test(line)) {
				return { fenced: !fenced, headings };
			}
			const match = fenced ? null : HEADING.exec(line);
			return {
				fenced,
				headings:
					match === null ? headings : [...headings, { level: match[1]?.length ?? 0, text: match[2] ?? '' }],
			};
		},
		{ fenced: false, headings: [] },
	).headings;

// The anchors of the headings given, a repeated one numbered from 1 as GitHub numbers it.
const withSlugs = (
	headings: readonly { level: number; text: string }[],
): readonly { level: number; slug: string; text: string }[] =>
	headings.reduce<{ seen: Map<string, number>; slugged: { level: number; slug: string; text: string }[] }>(
		({ seen, slugged }, heading) => {
			const base = slugOf(heading.text);
			const count = seen.get(base) ?? 0;
			return {
				seen: new Map(seen).set(base, count + 1),
				slugged: [...slugged, { ...heading, slug: count === 0 ? base : `${base}-${String(count)}` }],
			};
		},
		{ seen: new Map(), slugged: [] },
	).slugged;

/**
 * The anchors GitHub gives every heading of a Markdown file, in order, a repeated one numbered.
 *
 * @param markdown the file's text.
 */
export const headingSlugs = (markdown: string): readonly string[] =>
	withSlugs(headingsOf(markdown)).map(({ slug }) => slug);

/**
 * The sections a design file states: each H3, and each H2 with no H3 before the next H2, never a
 * heading inside a code block.
 *
 * @param markdown the file's text.
 */
export const leafSections = (markdown: string): readonly DesignSection[] => {
	const headings = withSlugs(headingsOf(markdown));
	return headings.flatMap(({ level, slug, text }, index) => {
		if (level === 3) {
			return [{ slug, text }];
		}
		if (level !== 2) {
			return [];
		}
		const next = headings.slice(index + 1).find((later) => later.level <= 3);
		return next === undefined || next.level !== 3 ? [{ slug, text }] : [];
	});
};

interface Row {
	cells: readonly string[];

	/** The section the row names, as `path#slug`, or none when its first cell links no design file. */
	section: string | undefined;
}

const linksIn = (cell: string): readonly string[] => [...cell.matchAll(LINK)].map((match) => match[2] ?? '');

// A link's target as a repository-relative path and anchor, from the list's directory.
const targetOf = (list: string, link: string): { anchor: string | undefined; path: string } => {
	const [path = '', anchor] = link.split('#');
	return { anchor, path: path === '' ? list : normalize(join(dirname(list), path)) };
};

const rowsOf = (list: string, text: string, designFiles: ReadonlySet<string>): readonly Row[] =>
	text
		.split('\n')
		.filter((line) => line.trimStart().startsWith('|'))
		.map((line) =>
			line
				.trim()
				.replace(/^\||\|$/gu, '')
				.split('|')
				.map((cell) => cell.trim()),
		)
		.filter((cells) => linksIn(cells[0] ?? '').length > 0)
		.map((cells) => {
			const [first = ''] = linksIn(cells[0] ?? '');
			const { anchor, path } = targetOf(list, first);
			return {
				cells,
				section: designFiles.has(path) && anchor !== undefined ? `${path}#${anchor}` : undefined,
			};
		});

const resolves = (workspace: Workspace, link: string): boolean => {
	if (/^[a-z]+:/iu.test(link)) {
		return true;
	}
	const { anchor, path } = targetOf(workspace.list, link);
	const text = workspace.read(path);
	return text !== undefined && (anchor === undefined || headingSlugs(text).includes(anchor));
};

const rowFindings = (workspace: Workspace, { cells }: Row, label: string): readonly TraceabilityFinding[] => {
	const [, status = '', tests = '', tracked = ''] = cells;
	const unresolved = cells
		.flatMap(linksIn)
		.filter((link) => !resolves(workspace, link))
		.map((link): TraceabilityFinding => ({
			message: `${label}: the link ${link} does not resolve`,
			rule: 'unresolvedLink',
		}));
	if (!STATUSES.has(status)) {
		return [
			{ message: `${label}: "${status}" is no status; use ${[...STATUSES].join(', ')}`, rule: 'unknownStatus' },
			...unresolved,
		];
	}
	const testFound = linksIn(tests).some((link) => !isWebLink(link) && resolves(workspace, link));
	const externalTest = linksIn(tests).some(isWebLink);
	const trackedIn = TRACKED_IN[status as SectionStatus];
	const isTracked =
		trackedIn === undefined ||
		linksIn(tracked).some((link) => trackedIn.includes(targetOf(workspace.list, link).path));
	return [
		...unresolved,
		...(TESTED_HERE.has(status) && !testFound
			? [{ message: `${label}: ${status}, and names no test that exists`, rule: 'builtWithoutTest' } as const]
			: []),
		...(status === 'external' && !externalTest
			? [
					{
						message: `${label}: external, and links no test in another repository`,
						rule: 'externalWithoutTest',
					} as const,
				]
			: []),
		...(isTracked
			? []
			: [
					{
						message: `${label}: ${status}, and links no item in ${(trackedIn ?? []).join(' or ')}`,
						rule: 'untrackedStatus',
					} as const,
				]),
	];
};

/**
 * Every reason the design traceability list does not stand: a design section with no row, a row
 * naming a heading that is no longer a section, a section given two rows, a status it does not
 * know, a link in any cell whose file or anchor does not resolve, a `built` section naming no test
 * that exists, and an `untested` or `planned` section linking no roadmap item, or an `open` one no
 * item in to-discuss.md. A `context` section, one that states no rule, needs no link.
 *
 * @param workspace the design files in scope, the list's path and a reader of each file.
 */
export const traceabilityFindings = (workspace: Workspace): readonly TraceabilityFinding[] => {
	const listText = workspace.read(workspace.list);
	if (listText === undefined) {
		return [{ message: `${workspace.list} does not exist`, rule: 'missingList' }];
	}
	const sections = workspace.designFiles.flatMap((path) =>
		leafSections(workspace.read(path) ?? '').map(({ slug, text }) => ({ key: `${path}#${slug}`, text })),
	);
	const known = new Set(sections.map(({ key }) => key));
	const rows = rowsOf(workspace.list, listText, new Set(workspace.designFiles));
	const named = rows.map(({ section }) => section);
	const perRow = rows.flatMap((row, index): readonly TraceabilityFinding[] => {
		const label = row.section ?? row.cells[0] ?? '';
		if (row.section === undefined || !known.has(row.section)) {
			return [{ message: `${label} names no section of the design files`, rule: 'staleRow' }];
		}
		const repeated = named.indexOf(row.section) !== index;
		return [
			...(repeated ? [{ message: `${label} has more than one row`, rule: 'duplicateRow' } as const] : []),
			...rowFindings(workspace, row, label),
		];
	});
	const listed = new Set(named);
	const missing = sections
		.filter(({ key }) => !listed.has(key))
		.map(({ key, text }): TraceabilityFinding => ({
			message: `${key} ("${text}") has no row`,
			rule: 'missingRow',
		}));
	return [...perRow, ...missing];
};
