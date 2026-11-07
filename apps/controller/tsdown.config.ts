import type { UserConfig } from 'tsdown';

// Each entry is keyed by the name of the file it builds, `<outDir>/<key>.js`, so the file run keeps its
// name whichever source file it starts from. The migrations are read at run time from `sql/` beside
// the module reading them, and tsdown writes every chunk to the top of the output folder, so the SQL
// folder is copied there, to `<outDir>/sql/`, whichever chunk holds that module.
const config: UserConfig = {
  copy: ['src/migrations/sql'],
  entry: { main: 'src/main.ts', migrate: 'src/migrate.ts' },
  fixedExtension: false,
  format: 'esm',
};

export default config;
