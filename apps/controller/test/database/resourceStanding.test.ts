import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import {
  administratorCaller,
  type AdminResponse,
  assertNotFound,
  assertSucceeded,
  carriesGrantSummary,
  comparableRefusal,
  personCaller,
  PROBLEMS,
  readResource,
  resourceViewOf,
} from '../../test-support/admin.js';
import type { Person } from '../../test-support/exchange.js';
import {
  ABSENT,
  APPLICATIONS,
  CAST,
  RESOURCES,
  resourcesFixture,
} from '../../test-support/fixtures/resources.js';
import { type Harness, suiteHarness } from '../../test-support/harness.js';
import { inTurn } from '../../test-support/policy.js';

// Beside the shared fixture: STUDY-S1, open and suppressed, where Eli holds an accepted viewer
// grant; and STUDY-X1, retired, which Ana owned until its retirement revoked her owner grant.
const SUPPRESSED = 'STUDY-S1';

const RETIRED = 'STUDY-X1';

const readAs = async (
  harness: Harness,
  person: Person,
  externalId: string,
): Promise<AdminResponse> =>
  readResource(await personCaller(harness, person), externalId);

const assertAnsweredAsAbsent = (
  answer: AdminResponse,
  absent: AdminResponse,
  label: string,
): void => {
  assertNotFound(absent, `${label}, the reference`, 'resourceNotFound');
  assertNotFound(answer, label, PROBLEMS.resourceNotFound.code);
  assert.deepEqual(comparableRefusal(answer), comparableRefusal(absent), label);
};

suite("a resource's read, by the reader's standing in the store", () => {
  const shared = suiteHarness({
    applications: APPLICATIONS,
    fixture: resourcesFixture({
      decisions: [
        { decision: 'accepted', grant: 'anaOwnedX1' },
        { decision: 'accepted', grant: 'eliViewsS1' },
      ],
      grants: {
        anaOwnedX1: {
          category: null,
          holder: { user: 'ana' },
          resource: RETIRED,
          revoked: {},
          role: 'owner',
        },
        eliViewsS1: {
          category: 'controlled',
          holder: { user: 'eli' },
          resource: SUPPRESSED,
          role: 'viewer',
        },
      },
      resources: {
        [RETIRED]: { baseTier: 'open', name: 'Retired study', retired: {} },
        [SUPPRESSED]: {
          baseTier: 'open',
          name: 'Suppressed study',
          suppressed: true,
        },
      },
    }),
  });

  test('answers a counted owner, and a holder of a pending or an accepted grant, with a grant summary for the owner alone', async () => {
    const harness = await shared();

    const answers = await inTurn(
      [CAST.owner, CAST.curator, CAST.holder],
      (person) => readAs(harness, person, RESOURCES.a1),
    );

    answers.forEach((answer, index) => {
      assertSucceeded(answer, `reader ${index}`);
      assert.equal(
        resourceViewOf(answer, `reader ${index}`).externalId,
        RESOURCES.a1,
      );
    });
    assert.deepEqual(
      answers.map(({ body }) => carriesGrantSummary(body)),
      [true, false, false],
    );
  });

  test('answers a holder whose grant was declined, revoked or has expired exactly as for a resource that does not exist', async () => {
    const harness = await shared();

    const pairs = await inTurn(
      [CAST.declinedHolder, CAST.revokedHolder, CAST.expiredHolder],
      async (person) => ({
        absent: await readAs(harness, person, ABSENT),
        held: await readAs(harness, person, RESOURCES.a1),
      }),
    );

    pairs.forEach(({ absent, held }, index) => {
      assertAnsweredAsAbsent(held, absent, `reader ${index}`);
    });
  });

  test('shows a suppressed resource to a holder of a grant on it and to a platform administrator, and to nobody else', async () => {
    const harness = await shared();

    const byHolder = await readAs(harness, CAST.holder, SUPPRESSED);
    const byAdministrator = await readResource(
      await administratorCaller(harness),
      SUPPRESSED,
    );
    const byOutsider = await readAs(harness, CAST.outsider, SUPPRESSED);
    const absent = await readAs(harness, CAST.outsider, ABSENT);

    assertSucceeded(byHolder, "the holder's read");
    assertSucceeded(byAdministrator, "the administrator's read");
    assertAnsweredAsAbsent(byOutsider, absent, "the outsider's read");
  });

  test('shows a retired resource to a platform administrator naming it, and to nobody else, its former owner included', async () => {
    const harness = await shared();

    const byAdministrator = await readResource(
      await administratorCaller(harness),
      RETIRED,
    );
    const byFormerOwner = await readAs(harness, CAST.owner, RETIRED);
    const byOutsider = await readAs(harness, CAST.outsider, RETIRED);
    const absent = await readAs(harness, CAST.outsider, ABSENT);

    assertSucceeded(byAdministrator, "the administrator's read");
    assert.equal(
      resourceViewOf(byAdministrator, "the administrator's read").retired,
      true,
    );
    assertAnsweredAsAbsent(byFormerOwner, absent, "the former owner's read");
    assertAnsweredAsAbsent(byOutsider, absent, "the outsider's read");
  });
});
