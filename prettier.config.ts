import type { Config } from 'prettier';

// embeddedLanguageFormatting and proseWrap keep each document's own line breaks, and code inside code blocks as written.
const config: Config = {
	embeddedLanguageFormatting: 'off',
	objectWrap: 'preserve',
	// YAML cannot be indented with tabs, so it keeps its two-space indentation.
	overrides: [{ files: ['*.yaml', '*.yml'], options: { tabWidth: 2 } }],
	printWidth: 120,
	proseWrap: 'preserve',
	semi: true,
	singleAttributePerLine: true,
	singleQuote: true,
	tabWidth: 4,
	trailingComma: 'all',
	useTabs: true,
};

export default config;
