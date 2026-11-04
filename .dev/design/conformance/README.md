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
[permissions-model.md](../permissions-model.md#the-seeded-roles-as-a-matrix) carry more. The baseline
and the signed-in rule grant what a viewer holds, so the `unmarked` entry each contributes carries
the same three actions:

| Role or rule   | Case table                           | Corpus                                                  |
| -------------- | ------------------------------------ | ------------------------------------------------------- |
| `viewer`       | `view`                               | `count`, `view`, `export`                               |
| `curator`      | `create`, `view`, `update`, `delete` | `count`, `view`, `export`, `create`, `update`, `delete` |
| baseline       | `{unmarked: [view]}`                 | `count`, `view`, `export`                               |
| signed-in rule | `{unmarked: [view]}`                 | `count`, `view`, `export`                               |

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

Every payload's `aud` is `arranger-prod`, the application's label, where an issued payload carries
the identifier generated when that application was registered. A test comparing an issued payload
with the corpus reads the label as the registered application's identifier.

        curator   count, view, export, create, update, delete
    viewer    count, view, export

    G1 "cardiology" and G2 "study readers" are named sets of people. A role is
    named on each grant, never on the group.

    HEART_STUDY    offers   controlled
    LUNG_COHORT    offers   no concrete category
    REEF_ARCHIVE   offers   controlled, community-governed
    VOID_INDEX     offers   no concrete category; unmarked records by grant

    Every other resource's unmarked records are open.

    The baseline is on and grants unmarked -> read (count, view and export)
    wherever the setting is open, except where a case turns it off.
    The audience serves all four resources, except where a case says otherwise.

## The signed-in rule's configuration

Cases 28 to 35 were computed against a second configuration, and each carries
`"configuration": "signed-in rule"`, so an entry without that field belongs to the one above:

    viewer    count, view, export

    OPEN_ATLAS       offers   no concrete category; unmarked records open
    MEMBERS_ARCHIVE  offers   no concrete category; unmarked records registered
    SEALED_ARCHIVE   offers   no concrete category; unmarked records by grant
    HEART_STUDY      offers   controlled; unmarked records open

    The baseline is on unless a case turns it off, and grants unmarked -> read
    (count, view and export) wherever the setting is open. The signed-in rule
    grants unmarked -> read (count, view and export) to every signed-in
    principal wherever the setting is registered.
    The audience serves all four resources.

Two of its cases have no payload and are listed under `omitted`, both refusals: 33 at the exchange,
and 34 at the bridge once the sign-in token is past its `exp` by the bridge's tolerance, or at the
exchange before that. Each belongs to those components' tests rather than to a payload.

## What each payload says a resource offers

Every payload's category members are read from the table of its configuration: `globalCategories`
lists the concrete global categories defined, `controlled` and `community-governed` in the first table
and `controlled` alone in the signed-in rule's, and `resourceCategories` lists, for each resource
named in `permissions`, its own resource categories, which no resource in either table defines.
`servedResources` lists every resource served by the audience, held or not, in the order its
configuration's table gives them: HEART_STUDY, LUNG_COHORT, REEF_ARCHIVE and VOID_INDEX in the
first, and OPEN_ATLAS, MEMBERS_ARCHIVE, SEALED_ARCHIVE and HEART_STUDY in the signed-in rule's. Each
payload lists all four, case 1 and case 29 included, though they hold nothing.
`.dev/check-fixtures.py` checks that `resourceCategories` names exactly the resources `permissions` names,
that every category held on a resource is `global.unmarked` or listed in one of the two members, and
that `servedResources` lists distinct resources, every one `permissions` or `resourceCategories`
names among them.

## What an application should serve

`expectations.json` holds, for each case it checks, what an application serves that case's principal
through one key, record by record. With the payload read from the `principals.json` entry it names,
a case carries everything needed to check it, so another implementation can check it from the two
files alone:

    formatVersion       1, which changes with the file's shape and never with its cases
    cases               one entry for each case checked
      principalId         the principals.json entry supplying the case's payload
      keyRegistration     the key, as usher-types' validateRegistration accepts it
      records             each record judged
        fields              its values by field name, the key's resource field among them
        outcome             served, withheld or denied
        reason              why, in a sentence

A record carries every category whose condition it matches, and lacking a field read by a condition
counts as matching it. It is served when the principal holds record view on its resource for each of
its categories, or for `global.unmarked` when it carries none, per
[permissions-model.md](../permissions-model.md#the-visibility-rule).

**A denial is its own outcome, never a withholding.** A record is `withheld` when the key narrows the
catalogue and the record falls outside the narrowing, and `denied` when the key refuses the catalogue
outright, as it does with `no-grants` for a principal holding nothing. Neither shows the record, and
only the outcome tells a refusal from an empty result.

`expectations.json` holds four cases, each judged against one key defining both global categories
on `data_category`:

| Case | What its records show                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | A principal holding nothing is denied the catalogue as `no-grants`                                                                                      |
| 10   | A VOID_INDEX record is withheld, being served and not held, while an unmarked HEART_STUDY record is served                                              |
| 22   | The record carrying both categories is withheld, beside records carrying each alone, none, or an empty or absent category field, which reads as missing |
| 23   | A value expected by no condition is served as unmarked, while a `controlled` record on the same study is withheld                                       |

**A later case fits without a change of shape**, since each input is open where a new mechanism would
reach it: a key is whatever `validateRegistration` accepts, and a record can hold any field read by
a key. Whether withholding, case 21's mechanism, is configured in the registration or carried in the
payload, a case already names both, so case 21 needs only records carrying the field read by
withholding, each still served or withheld.

**A case enters `expectations.json` only once it is implementable.** The bridge's test reading the
file, `modules/express-bridge/src/core/rendering.conformance.test.ts`, and `.dev/check-fixtures.py`
each fail on a case there marked `"implementable": false` in `principals.json`, rather than skipping
it: a skip would let the flag switch an assertion off with nothing announcing it.

## Cases marked not implementable

One entry carries `"implementable": false`, case 21. It is a case rather than a note, per
`token-calculation.md`: a case written before the mechanism is a specification, and one written after
is a description.

It carries an ordinary payload, case 05's, since nothing in a payload can express withholding, and
that payload is what a correct controller emits. It is the only case distinguishing the two readings
of the model, additive grants against a narrowed ceiling, and until something can withhold, no test
can catch an implementation that gets the direction wrong. Writing it before the feature pins the
invariant.

Case 22, a record carrying two categories, is implementable, and its records are in
`expectations.json`. Case 23, a value no condition expects, is settled by governance: it is
`unmarked` unless a catch-all negation covers it, and its records are in `expectations.json`.
