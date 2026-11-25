import type { UserConfig } from 'tsdown';

// Each entry is keyed by the name of the file it builds, `<outDir>/<key>.js`, so the file run keeps its
// name whichever source file it starts from. The migrations are read at run time from `sql/` beside
// the module reading them, and tsdown writes every chunk to the top of the output folder, so the SQL
// folder is copied there, to `<outDir>/sql/`, whichever chunk holds that module. The workspace
// packages the controller imports are development dependencies, so the build bundles them, read
// from their source through the `@overture-stack/source` condition as the tests read them: a
// package's own build need not exist, and none is shipped beside the controller's.
const config: UserConfig = {
	copy: ['src/migrations/sql'],
	entry: { main: 'src/main.ts', migrate: 'src/migrate.ts' },
	fixedExtension: false,
	format: 'esm',
	inputOptions: { resolve: { conditionNames: ['@overture-stack/source', 'import', 'node', 'default'] } },
};

export default config;
