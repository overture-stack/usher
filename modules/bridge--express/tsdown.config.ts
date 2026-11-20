import type { UserConfig } from 'tsdown';

const config: UserConfig = {
	dts: true,
	entry: ['src/index.ts', 'src/testing.ts'],
	fixedExtension: false,
	format: 'esm',
};

export default config;
