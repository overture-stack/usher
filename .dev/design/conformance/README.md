# Conformance fixtures

`principals.json` here is the draft of the file placed by `phase-1.md` at
`.dev/usher-integration/conformance/principals.json` in the integration repository. It is drafted in
this repository because that section names `principals.json` as Usher's to own. Owning a file and
hosting it are separate, and moving it is a step of its own.

## What this file is

Each entry is a principal and the `PermissionsPayload` handed to an application on their behalf by a
conformance run. The payloads are verbatim in the shape defined by
[security-workflow.md](../security-workflow.md#the-payload-as-a-type), so an adapter can deserialize
them with the bridge's own type.

**It is an input, never an expectation.** What an application should serve given one of these lives
in `expectations.json`. The split matters because the two answer different questions of different
systems, and one file cannot hold both.

## Where the entries come from

Every entry traces to a numbered case in
[token-calculation.md](../token-calculation.md#the-cases-that-force-each-branch), carried in its
`case` field. Those cases assert what the controller _computes_; this file is the computed result,
which is the input to what an application then _serves_. The two corpora chain at exactly this file.

Cases that produce no payload are absent, with a `notes` entry saying why. Case 25 is the clear one:
a grant pairing `record.delete` with a field category is refused at writing, so no token exists to
put here and the case belongs to Usher's own schema tests.

## Two places this diverges from the case table, deliberately

**Roles expand against the seeded matrix, not the case table's local configuration.** That table
declares `curator carries create, view, update, delete` and `viewer carries view`, which is a
reduction that keeps the table readable. The seeded roles in
[permissions-model.md](../permissions-model.md#the-seeded-roles-as-a-matrix) carry more:

| Role      | Case table                           | Seeded                                                  |
| --------- | ------------------------------------ | ------------------------------------------------------- |
| `viewer`  | `view`                               | `count`, `view`, `export`                               |
| `curator` | `create`, `view`, `update`, `delete` | `count`, `view`, `export`, `create`, `update`, `delete` |

A fixture claiming to hold real tokens has to hold the real role. The case table's reduction stays
correct for what it is teaching, and the two should not be reconciled by widening the table, which
would make every row harder to read to no purpose.

**Temporal claims are illustrative.** Every payload carries `iat` 1767225600 and `exp` 1767225900,
a fixed reference instant of 2026-01-01T00:00:00Z with the five minute TTL. The corpus does not
evaluate them, since `phase-1.md` scopes token issuance and verification out of it. An adapter that
validates `exp` against the wall clock is testing beyond what this corpus asserts.

## The configuration these payloads were computed against

The payloads name every category with its scope prefix, `global.`, as every version 1 payload does;
the configuration below names them without it.

        curator   count, view, export, create, update, delete
    viewer    count, view, export

    G1 "cardiology" and G2 "study readers" are named sets of people. A role is
    named on each grant, never on the group.

    HEART_STUDY    carries  controlled
    LUNG_COHORT    carries  no concrete category
    REEF_ARCHIVE   carries  controlled, community-governed
    VOID_INDEX     carries  no concrete category; unmarked records by grant

    Every other resource's unmarked records are open.

    The baseline is on and grants unmarked -> read wherever the setting is open,
    except where a case turns it off.
    The audience serves all four resources, except where a case says otherwise.

## The signed-in rule's configuration

Cases 28 to 35 were computed against a second configuration, and each carries
`"configuration": "signed-in rule"`, so an entry without that field belongs to the one above:

    viewer    count, view, export

    OPEN_ATLAS       carries  no concrete category; unmarked records open
    MEMBERS_ARCHIVE  carries  no concrete category; unmarked records registered
    SEALED_ARCHIVE   carries  no concrete category; unmarked records by grant
    HEART_STUDY      carries  controlled; unmarked records open

    The baseline is on unless a case turns it off, and grants unmarked -> read
    wherever the setting is open. The signed-in rule grants unmarked -> read to
    every signed-in principal wherever the setting is registered.
    The audience serves all four resources.

Two of its cases have no payload and are listed under `omitted`, both refusals: 33 at the bridge
and 34 at the exchange, so each belongs to that component's tests rather than to a payload.

## Cases marked not yet implementable

Two entries carry `"implementable": false`, cases 21 and 22. They are cases rather than notes, per
`token-calculation.md`: a case written before the mechanism is a specification, and one written after
is a description.

Both carry an ordinary payload, which is the substance of each. Neither withholding nor the
multi-category subset test can be expressed in a payload at all, so what is unimplementable lives in
`expectations.json` and the payload here is what a correct controller emits today. Case 23 is not
among them: an unmapped category value is a live defect rather than an absent mechanism.

Case 21 is the one worth knowing about. It is the only case distinguishing the two readings of the
model, additive grants against a narrowed ceiling, and until something can withhold, no test can
catch an implementation that gets the direction wrong. Writing it now pins the invariant ahead of the
feature.
