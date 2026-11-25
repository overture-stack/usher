# Deployed-stack tests: the plan

Every suite so far tests a part with its neighbours stood in for. Arranger's adapter suite runs the
real Bridge against a mocked Controller, at `.dev/docs/arranger-auth/usher-adapter-tests.md` in
Arranger's repository. The Bridge's suite mocks the Controller too ([bridge-tests.md](bridge-tests.md)),
and the Controller's suite runs against its own store with sign-in tokens signed by test keys. This file is the
plan for the tests that run the parts as deployed: a person signs in at the identity provider, and
their token travels through Arranger's search server, the Bridge, the Controller and the search
engine, with nothing mocked.

These tests check what only the assembled stack can show: that the parts agree on audiences,
issuers, keys and clocks, that deployment settings reach each part, and that a decision made in the
Controller is the one a person meets in a search answer. They do not repeat the case tables, which
the suites below already cover.

---

## What these tests cover, and what they leave to others

| Concern                                                                  | Where it is tested              |
| ------------------------------------------------------------------------ | ------------------------------- |
| A sign-in token from the identity provider accepted end to end           | here                            |
| A grant made through the Management API reaching a search answer         | here                            |
| Every enforcement result's effect on records, counts, facets and exports | Arranger's adapter suite        |
| Rendering each key's result from the payload, caching, degraded modes    | the Bridge's suite              |
| What the Controller computes from grants, groups and decisions           | the Controller's suite          |
| Saving a set, and `artifact.create`, against each selection shape        | Arranger's GraphQL router suite |
| Load and timing                                                          | the load suite, separately      |

---

## The stack

| Part              | As deployed                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity provider | Keycloak, with self-registration and email verification, and a mail catcher for the verification and reset emails                                                                                     |
| Sign-in client    | A public client using the authorization code flow with PKCE, whose access tokens carry the Arranger application's id in `aud`                                                                         |
| Controller        | One instance or more, with the Management API                                                                                                                                                         |
| Arranger          | The search server image with `ENABLE_ACCESS_ENFORCEMENT=true`, its `USHER_*` settings, and an `auth.json` beside each catalogue's `base.json`                                                         |
| Directory         | Keycloak's admin API, read by the Controller through a confidential client whose service account holds `realm-management`'s `query-users` and `view-users` alone, on the instances whose cases use it |
| Search engine     | The catalogues' indices on synthetic data, the role holding the privileges Arranger's feature-flags reference lists for enforcement                                                                   |

---

## Fixtures

The data is synthetic throughout, so reading records in full is fine.

| Fixture              | What it is                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The application      | Arranger's search server, registered in the Controller, its key held only in the deployment's secret store                                                                                       |
| The resource         | One resource on the catalogue's resource field, access level `grant`, served by the application                                                                                                  |
| The category         | `global.controlled`, defined in the catalogue's `auth.json` as a SQON condition on a keyword field that splits the records roughly in half                                                       |
| Open catalogues      | Every other catalogue declared open in its `auth.json`                                                                                                                                           |
| Roles                | One carrying `record.view`; one carrying `record.view` and `artifact.create`                                                                                                                     |
| Test users           | Each self-registered with an address at a reserved domain, and verified through the mail catcher                                                                                                 |
| The test application | `usher-tests`, registered in the Controller and kept across runs, its key in the deployment's secret store for the test runner alone, through which the tests exchange sign-in tokens themselves |
| The test client      | A Keycloak client whose audience mapper puts `usher-tests` in `aud`, kept across runs                                                                                                            |
| The directory client | The confidential client the Controller reads Keycloak's admin API through, configured with the deployment and never changed by a run                                                             |
| Fresh accounts       | Self-registered as the test users are, one per case needing a person Usher has never met, since a person once met stays met                                                                      |
| Test administrator   | A test user nominated as platform administrator for setup and teardown, kept for later runs and removed through `DELETE /admin/administrators/{subject}` once no longer needed                   |

| Test user | Grants                                                                           |
| --------- | -------------------------------------------------------------------------------- |
| full      | `record.view` and `artifact.create` across the resource                          |
| partial   | `record.view` across the resource, `artifact.create` only on `global.controlled` |
| view-only | `record.view` across the resource                                                |
| no-grants | none                                                                             |

---

## Happy paths

| Case                                                        | Expected                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Each test user searches the catalogue                       | Records and counts match that user's grants, as a direct engine query with the same filter shows                     |
| Anonymous search                                            | The open tier's answer                                                                                               |
| full saves a set from any selection                         | Saved, attributed to them, and listed for them                                                                       |
| partial saves a set from records inside `global.controlled` | Saved                                                                                                                |
| A grant made through the Management API mid-run             | The next search answers with it, within the Bridge's notice latency                                                  |
| A revocation made mid-run                                   | The next search answers without it, within the same latency                                                          |
| Startup                                                     | The adapter's startup checks pass, and the log shows `access enforcement: on` and `server-side filter source: Usher` |

## Adversarial paths

| Case                                                                                                                                                                     | Expected                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| partial saves a set from records outside `global.controlled`, by a narrow selection, by an empty filter, and by a selection sharing a saved value with an outside record | Refused, naming `artifact.create`, and nothing saved                                         |
| view-only and no-grants save any set                                                                                                                                     | Refused, naming `artifact.create`                                                            |
| A selection matching no records, by a user holding `artifact.create` nowhere                                                                                             | Refused                                                                                      |
| A token from a client whose tokens lack the application's audience                                                                                                       | Treated as unconfirmed: searches from the open tier, everything else answered as unavailable |
| A malformed, expired, unsigned or signed-out token                                                                                                                       | The same, and never data beyond the open tier                                                |
| Reading another user's set by its id                                                                                                                                     | Answers exactly as a missing set                                                             |
| Reading a set from another catalogue by its id                                                                                                                           | Answers exactly as a missing set                                                             |
| Any refusal or error                                                                                                                                                     | No stack trace, internal hostname, file path or record value in the answer                   |

---

## Knowing a person

The Controller knows a person in one of two ways: it has met them, when a sign-in token of theirs was
exchanged through an application, or a configured directory finds their account. Each way gets its
own cases, the first on an instance with no directory configured.

**Without a directory.** Each case starts from a fresh account.

| Case                                                                             | Expected                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The test administrator nominates the account before it has exchanged             | 404 `nomineeNotFound`                                                                                                                                              |
| The account exchanges once through `usher-tests`, then is nominated              | 201, the nomination `pending`                                                                                                                                      |
| The account exchanges a token whose `aud` lacks `usher-tests`, then is nominated | The exchange refused 403 `credentialRefused`, recorded `denied` under `otherAudience`; the nomination 404 `nomineeNotFound`, since a refused exchange meets nobody |

**With a directory.**

| Case                                                                                                                         | Expected                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The test administrator nominates a realm account Usher has never met                                                         | 201, the nomination `pending`                                                                                                                         |
| A grant whose holder is named by address, and a resource registered with an owner by address, both by the test administrator | Each names the subject of the account holding that address, as the resource's grant listing shows                                                     |
| Listings naming people, to a principal other than a platform administrator                                                   | Given and family names as the directory holds them                                                                                                    |
| The same listings to the test administrator                                                                                  | Each holder by subject, with the address the directory holds                                                                                          |
| Keycloak's admin API unreachable: a grant naming its holder by address, and a listing naming people by name                  | 503 `directoryUnavailable`, with no `Retry-After`; the instance writes `directory.unavailable` at error, naming its cause and no URL, token or secret |

---

## Setup and teardown

Setup runs in this order: the test users, the fresh accounts and the test administrator; the
application, its key into the secret store; `usher-tests` and the test client, where they do not
exist yet; the sign-in client's audience mapper; the category, the resource and the grants;
the search engine privileges; then Arranger's `auth.json` files and settings, and a rollout.

Teardown reverses it: Arranger's settings and files back, the audience mapper removed, and every
nomination a run left pending revoked. The test users, their grants and the test administrator may
stay for the next run. `usher-tests`, the test client and the directory client always stay: the
first two are permanent fixtures, and the directory client is the deployment's configuration. A
fresh account, once met, is never fresh again, so each run registers its own.

Each run's requests are paced, capped in number, and limited to the stack under test.
