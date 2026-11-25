import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { headingSlugs, leafSections, traceabilityFindings, type Workspace } from './design-traceability.ts';

const LIST = '.dev/docs/design-traceability.md';

const DESIGN = `# Rules

## Tokens

### How long a token lasts

Five minutes.

### Who may hold one

Anyone signed in.

## Revocation

It takes effect at once.

\`\`\`text
## Not a heading
\`\`\`
`;

const ROADMAP = '# Roadmap\n\n### Write the revocation test\n';

const DISCUSS = '# To discuss\n\n## Who may hold one\n';

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

const listOf = (rows: readonly string[]): string =>
	[
		'# Design traceability',
		'',
		'## rules.md',
		'',
		row(['Section', 'Status', 'Test', 'Tracked in', 'Explained by']),
		row(['---', '---', '---', '---', '---']),
		...rows,
		'',
	].join('\n');

const LASTS = '[How long a token lasts](../design/rules.md#how-long-a-token-lasts)';
const HOLDS = '[Who may hold one](../design/rules.md#who-may-hold-one)';
const REVOKES = '[Revocation](../design/rules.md#revocation)';
const TEST = '[`token.test.ts`](../../src/token.test.ts)';

const COMPLETE = [
	row([LASTS, 'built', TEST, '', '']),
	row([HOLDS, 'open', '', '[Who may hold one](../design/to-discuss.md#who-may-hold-one)', '']),
	row([REVOKES, 'untested', '', '[Write the revocation test](../roadmap.md#write-the-revocation-test)', '']),
];

const workspace = (list: string, extra: Readonly<Record<string, string>> = {}): Workspace => {
	const files: Readonly<Record<string, string>> = {
		'.dev/design/rules.md': DESIGN,
		'.dev/design/to-discuss.md': DISCUSS,
		'.dev/roadmap.md': ROADMAP,
		[LIST]: list,
		'src/token.test.ts': '',
		...extra,
	};
	return {
		designFiles: ['.dev/design/rules.md'],
		list: LIST,
		read: (path) => files[path],
	};
};

const rulesOf = (list: string, extra?: Readonly<Record<string, string>>): readonly string[] =>
	traceabilityFindings(workspace(list, extra)).map(({ rule }) => rule);

suite('the sections a design file states', () => {
	test('are its H3 sections, and each H2 with none under it, never a heading in a code block', () => {
		assert.deepEqual(
			leafSections(DESIGN).map(({ slug }) => slug),
			['how-long-a-token-lasts', 'who-may-hold-one', 'revocation'],
		);
	});

	test('are named by the anchors GitHub gives them, a repeated heading numbered', () => {
		assert.deepEqual(headingSlugs('## A rule: `code`, and *more*!\n\n### Same\n\n### Same\n'), [
			'a-rule-code-and-more',
			'same',
			'same-1',
		]);
	});
});

suite('checking the design traceability list', () => {
	test('finds nothing when every section has a row and every row stands', () => {
		assert.deepEqual(rulesOf(listOf(COMPLETE)), []);
	});

	test('fails a section with no row, and a row naming a heading that no longer exists', () => {
		const rows = [...COMPLETE.slice(1), row(['[Gone](../design/rules.md#gone)', 'context', '', '', ''])];

		assert.deepEqual(rulesOf(listOf(rows)).toSorted(), ['missingRow', 'staleRow']);
	});

	test('fails a link whose file or anchor does not resolve, in any cell', () => {
		const rows = [
			row([LASTS, 'built', TEST, '', '[Note](../docs/atlas/missing.md)']),
			...COMPLETE.slice(1, 2),
			row([REVOKES, 'untested', '', '[Write it](../roadmap.md#no-such-item)', '']),
		];

		assert.deepEqual(rulesOf(listOf(rows)), ['unresolvedLink', 'unresolvedLink']);
	});

	test('accepts built only with a test that exists, and untested, planned or open only with a tracking link', () => {
		const rows = [
			row([LASTS, 'built', '', '', '']),
			row([HOLDS, 'open', '', '', '']),
			row([REVOKES, 'untested', '', '', '']),
		];

		assert.deepEqual(rulesOf(listOf(rows)), ['builtWithoutTest', 'untrackedStatus', 'untrackedStatus']);
	});

	test('tracks an untested or planned section in the roadmap alone', () => {
		const rows = [
			...COMPLETE.slice(0, 2),
			row([REVOKES, 'untested', '', '[Who may hold one](../design/to-discuss.md#who-may-hold-one)', '']),
		];

		assert.deepEqual(rulesOf(listOf(rows)), ['untrackedStatus']);
	});

	test('fails a status it does not know, and a section given two rows', () => {
		const rows = [...COMPLETE, row([LASTS, 'done', '', '', ''])];

		assert.deepEqual(rulesOf(listOf(rows)).toSorted(), ['duplicateRow', 'unknownStatus']);
	});

	test('fails a missing list, naming it', () => {
		const findings = traceabilityFindings({ ...workspace(''), read: () => undefined });

		assert.deepEqual(
			findings.map(({ message, rule }) => [rule, message.includes(LIST)]),
			[['missingList', true]],
		);
	});
	test('accepts external only with a test linked in another repository', () => {
		const external = (tests: string): readonly string[] =>
			rulesOf(listOf([row([LASTS, 'external', tests, '', '']), ...COMPLETE.slice(1)]));

		assert.deepEqual(
			[
				external('[`spec.test.ts`](https://github.com/overture-stack/arranger/blob/main/spec.test.ts)'),
				external(TEST),
				external(''),
			],
			[[], ['externalWithoutTest'], ['externalWithoutTest']],
		);
	});

	test('accepts partial only with a test that exists and a roadmap item for the part not built', () => {
		const partial = (tests: string, tracked: string): readonly string[] =>
			rulesOf(listOf([row([LASTS, 'partial', tests, tracked, '']), ...COMPLETE.slice(1)]));
		const roadmap = '[Write the revocation test](../roadmap.md#write-the-revocation-test)';

		assert.deepEqual(
			[partial(TEST, roadmap), partial('', roadmap), partial(TEST, '')],
			[[], ['builtWithoutTest'], ['untrackedStatus']],
		);
	});

	test('tracks an open section in the roadmap or in to-discuss, whichever holds it', () => {
		const rows = [
			COMPLETE[0] ?? '',
			row([HOLDS, 'open', '', '[Write the revocation test](../roadmap.md#write-the-revocation-test)', '']),
			COMPLETE[2] ?? '',
		];

		assert.deepEqual(rulesOf(listOf(rows)), []);
	});
});
