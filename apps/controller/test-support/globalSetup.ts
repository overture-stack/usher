import type * as Build from './build.js';
import type * as ContainerEnvironment from './containerEnvironment.js';
import type * as Containers from './containers.js';

// Node's test runner loads this module in its own process, which runs none of tsx's hooks: only
// Node's type stripping applies. So the modules below are loaded by their .ts file names at run
// time, typed by the imports above, and they keep to erasable syntax and import no sibling's values.
const loadBeside = async <Module>(fileName: string): Promise<Module> =>
  (await import(new URL(fileName, import.meta.url).href)) as Module;

const run: {
  build: URL | undefined;
  started: Containers.StartedContainers | undefined;
} = {
  build: undefined,
  started: undefined,
};

/**
 * Starts the run's containers and builds the Controller, at once, and publishes both to the test files
 * through the environment. Whichever is ready when the other fails is stopped or removed. Node's test
 * runner calls it once, before any test file starts, when given `--test-global-setup`.
 */
export const globalSetup = async (): Promise<void> => {
  const [
    { buildController, environmentForBuild, removeBuild },
    { environmentForContainers },
    { startContainers },
  ] = await Promise.all([
    loadBeside<typeof Build>('./build.ts'),
    loadBeside<typeof ContainerEnvironment>('./containerEnvironment.ts'),
    loadBeside<typeof Containers>('./containers.ts'),
  ]);
  const [built, started] = await Promise.allSettled([
    buildController(),
    startContainers(),
  ]);
  if (built.status === 'fulfilled' && started.status === 'fulfilled') {
    run.build = built.value;
    run.started = started.value;
    Object.assign(
      process.env,
      environmentForBuild(built.value),
      environmentForContainers(started.value.containers),
    );
    return;
  }
  await Promise.all([
    built.status === 'fulfilled' ? removeBuild(built.value) : undefined,
    started.status === 'fulfilled' ? started.value.stop() : undefined,
  ]);
  const [failure] = [built, started].filter(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  );
  throw failure?.reason;
};

/**
 * Stops the run's containers and removes its build, settling once both are done. The test runner
 * calls it after every test file has ended.
 */
export const globalTeardown = async (): Promise<void> => {
  const { build, started } = run;
  const { removeBuild } = await loadBeside<typeof Build>('./build.ts');
  await Promise.all([
    started?.stop(),
    build === undefined ? undefined : removeBuild(build),
  ]);
  run.build = undefined;
  run.started = undefined;
};
