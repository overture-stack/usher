import type * as ContainerEnvironment from './containerEnvironment.js';
import type * as Containers from './containers.js';

// Node's test runner loads this module in its own process, which runs none of tsx's hooks: only
// Node's type stripping applies. So the modules below are loaded by their .ts file names at run
// time, typed by the imports above, and they keep to erasable syntax and import no sibling's values.
const loadBeside = async <Module>(fileName: string): Promise<Module> =>
  (await import(new URL(fileName, import.meta.url).href)) as Module;

const run: { started: Containers.StartedContainers | undefined } = {
  started: undefined,
};

/**
 * Starts the run's containers and publishes them to the test files through the environment. Node's
 * test runner calls it once, before any test file starts, when given `--test-global-setup`.
 */
export const globalSetup = async (): Promise<void> => {
  const [{ environmentForContainers }, { startContainers }] = await Promise.all(
    [
      loadBeside<typeof ContainerEnvironment>('./containerEnvironment.ts'),
      loadBeside<typeof Containers>('./containers.ts'),
    ],
  );
  const started = await startContainers();
  run.started = started;
  Object.assign(process.env, environmentForContainers(started.containers));
};

/** Stops the run's containers, settling once each has stopped. The test runner calls it after every test file has ended. */
export const globalTeardown = async (): Promise<void> => {
  await run.started?.stop();
  run.started = undefined;
};
