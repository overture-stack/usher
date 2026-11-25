# Controller tests: the rules they follow

The Controller's tests check it from outside, through its HTTP API, its database and the notices a
Bridge reads. [apps/controller/testing/README.md](../../apps/controller/testing/README.md) describes
the support modules that do it, and
[apps/controller/DEVELOPMENT.md](../../apps/controller/DEVELOPMENT.md) where the tests live and how
to run them. This file holds the rules those tests follow, and what each one keeps from going wrong.
The Bridge's own plan is [bridge-tests.md](bridge-tests.md).

Some of these rules were set by rulings made in conversation and not written down at the time. They
are written here after the fact, from the tests and the support modules.

---

## Seeding

**A test seeds policy by SQL, and acts through the API.** Grants, resources and administrators a
test needs before it starts are written straight into the store, through `policy.ts`, and the
operation under test is then made through the API. Seeding through the API would make every test
depend on every operation it uses to set up, so a broken registration would fail every grant test,
and no test could set up a state the API refuses to reach, such as an expired grant.

**A token makes no administrator, so the harness seeds each one into the store** before acting as
them, as the Controller reads its administrators from its own records.

**Each test starts on an empty Valkey.** A suite's tests share a Valkey of their own, flushed for
each test, and never flush the one the whole run shares, so a wake-up or a cached value left by one
test never decides another.

## Time

**A test moves the clock, never waits for it.** The Controller is given a fixed or an adjustable
clock, as [decisions.md](../design/decisions.md) § The Controller's clock is configuration, and
every duration it measures runs on it, so an expiry is tested by moving the clock.

**Two timing profiles run the Bridge against the Controller.** `ims` is the Bridge's and the
Controller's defaults. `compressed` shortens every interval to a second or two, such as a 2-second
poll and a 4-second grace period, so an outage test sees a Bridge lapse, recover and raise within
seconds rather than minutes. Each profile has a Bridge half and a Controller half, and a test names
the profile, never single values, so the two halves always agree.

**"Within seconds" means 2 seconds on loopback.** A notice reaches a connected Bridge within that
bound, and a lapse may be logged up to 100 milliseconds after the grace period.

## Outages and restarts

**An outage is caused, never simulated in the code under test.** The harness pauses or stops the
database, takes Valkey down, slows or cuts the relay between a Bridge and the Controller, or stops
the Controller, each by name, and ends it the same way. The code under test meets a real failure.

**A restart keeps the configuration, the database, the keys and the port**, so a Bridge pointed at
the Controller reaches the restarted one without being told.

**A restore follows the order an operator would**: a consistent snapshot taken while the Controller
runs, the Controller stopped, the snapshot restored with its triggers disabled, a new notice-stream
epoch, unless the test keeps the snapshot's, and the Controller started. A Bridge holding a cursor
from before the restore is then answered `410`, as [schema.md](../design/schema.md) § The notice
stream requires.

**A migration given a runtime role that does not exist fails part way.** The test runs the
migrations directly, below the schema migration command, which refuses a missing role before writing
anything, as [deployment.md](../../docs/deployment.md) § The two database roles says.

## Conformance

**The conformance corpus is replayed against the Controller under six configurations**: A, A', B,
and the variants A-off, with enforcement switched off, A-auto, with grants accepted automatically,
and B-off. The base configurations are those in
[conformance/README.md](../design/conformance/README.md) § The configuration these payloads were
computed against.

**A payload is compared with the corpus as the corpus means it.** The corpus's `aud` label is read
as the id the harness registered that application under. `globalCategories`, `servedResources` and
`resourceCategories` are compared as sets, since their order carries nothing. Temporal claims are
left out, since the corpus was computed at another instant.

**A narrowing is judged by the SQON evaluator in usher-types**, copied into the test support with
the helpers it uses, so the tests judge a filter by the same rules the payload contract states,
without importing a test-only module from a package.

**Gap tests cover what the coverage review found untested.** Where the exchange's behaviour as the
Bridge reads it had no test, a test was added beside the conformance replay, rather than leaving the
behaviour to the Bridge's own suite.

## Refusals

**Two refusals that must look the same are compared on the wire**: the same status, body text and
header names, and the same value for every header but `date` and the per-request correlation ids,
whose names alone are compared. A difference anywhere else would let a caller tell the two cases
apart, which [openapi.json](../../apps/controller/openapi.json) promises it cannot.

## Real services

**A test whose outcome is the identity provider's own runs against a real Keycloak realm**, not the
directory stand-in, which answers as a test scripts it and so cannot show what Keycloak does.
