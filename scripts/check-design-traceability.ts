import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { traceabilityFindings, type Workspace } from './design-traceability.ts';

const workspaceRoot = resolve(import.meta.dirname, '..');

// Design files that state no rules of their own: the index routing to the others, the definitions of
// terms, the pictures of schema.md, and the list of open items, which is where an open row links.
const EXCLUDED: ReadonlySet<string> = new Set(['README.md', 'glossary.md', 'schema-diagrams.md', 'to-discuss.md']);

/**
 * The repository as the design traceability check reads it: every Markdown file in `.dev/design/`
 * but those that state no rules of their own, and the list at `.dev/docs/design-traceability.md`.
 *
 * @param root the repository's root.
 */
export const repositoryWorkspace = (root: string = workspaceRoot): Workspace => ({
	designFiles: readdirSync(join(root, '.dev/design'))
		.filter((name) => name.endsWith('.md') && !EXCLUDED.has(name))
		.toSorted()
		.map((name) => `.dev/design/${name}`),
	list: '.dev/docs/design-traceability.md',
	read: (path) => {
		try {
			return readFileSync(join(root, path), 'utf8');
		} catch {
			return undefined;
		}
	},
});

if (import.meta.main) {
	const findings = traceabilityFindings(repositoryWorkspace());
	findings.forEach(({ message, rule }) => {
		console.error(`${rule}: ${message}`);
	});
	console.log(
		findings.length === 0
			? 'The design traceability list stands.'
			: `${String(findings.length)} finding(s): the design traceability list does not stand.`,
	);
	process.exitCode = findings.length === 0 ? 0 : 1;
}
