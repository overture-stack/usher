# Categories local to one resource

Post-MVP. An owner creates a category that exists only in their resource, so a study divides its own
records without growing the shared list seen by every other study. Shared categories such as
`controlled` stay, and remain the only kind governed by a custodian.

## What it looks like

HEART_STUDY's owner creates `pilot`, selecting the records whose `consent_group` is `PILOT`, a field
already on the study's submissions:

| Step | What happens                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 1    | the category is stored on HEART_STUDY as `resource.pilot`; the shared list is unchanged, and no other resource sees it |
| 2    | HEART_STUDY's PILOT records now need a grant naming it, and leave `unmarked`, which covers only what no other category claims, so access narrows |
| 3    | the owner grants a researcher `resource.pilot` on HEART_STUDY as a viewer, a grant of the same shape as today's |
| 4    | the researcher's token gains `resource.pilot` under HEART_STUDY, beside `global.unmarked`                          |

## What a category becomes

|                       | Shared                   | Local                             |
| --------------------- | ------------------------ | --------------------------------- |
| scope                 | the platform             | one resource                      |
| name                  | `global.controlled`      | `resource.pilot`                  |
| created by            | an admin, and only one   | the resource's owner, or an admin |
| governed by           | its custodian, and each carrying resource's owner | the resource's owner              |
| grant and token shape | unchanged                | unchanged                         |

**A category is its name and its scope, and the name carries the scope as a prefix**, for example
`global.controlled` and `resource.controlled`. There is no separate display name. The prefix names
the kind of scope rather than the resource, because everywhere a category name appears, in a grant, a
token entry or an audit record, already names its resource. So two studies can each hold a
`resource.pilot`, a local `controlled` cannot be mistaken for the shared one in a token entry, and no
resource identifier has to be kept free of the separator. A name itself cannot contain the separator.
The exact spelling is settled with the schema.

**A name is never changed.** It is the key used by the token, the adapter mapping and the audit log,
so renaming is removing one category and creating another, announced as any category change is. An
adapter's mapping for a local category is keyed by its resource as well as its name, since
`resource.pilot` can select different records in each study that defines one.

**A name typed by an owner is data.** The admin model makes category naming an operator
responsibility, and owners are not operators. A local category's name is shown only to people who
can already see that resource's categories, and never in a refusal, on the same principle as the
requirement that display labels on a field used as an access-control key be narrowed per principal
([to-discuss.md](../../../design/to-discuss.md)).

## The rule that makes it safe

**A local category only ever adds a restriction.** A record carrying a shared category and a local
one needs both grants, and the trace shows what happens otherwise:

| Step | What happens                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- |
| 1    | a REEF_ARCHIVE record is community-governed, and its `consent_group` is PILOT                      |
| 2    | REEF_ARCHIVE's owner creates a local `pilot` on `consent_group` PILOT and grants it                |
| 3    | if either grant were enough, a `pilot` grant alone would reach community-governed records, and one category's restriction would be bypassed by another's |

That is the conjunction under "A category selects records within a resource" in
[decisions.md](../../../design/decisions.md): every category carried by a record must be held. It
waits on a subset test, still inexpressible in the query layer, and until it lands a record carries
one category, so local categories cannot ship before it.

**No narrower form avoids this.** Restricting local categories to new values in the field read by a
shared category would stop one record matching two categories, but only by having owners write
access decisions into their records. That field would then be prescriptive, and enforcement reads
descriptive fields only (decisions.md, "Usher is data-agnostic").

## Open: where a local category's mapping lives

Usher never learns what a category selects: the field and value live in each application's adapter
configuration. An owner creating a category through the management interface therefore either writes
its mapping into Usher, which gives up that principle, or waits for a configuration change in every
application serving the resource. Until an application has a mapping, the category is unmapped there
and its records are denied, which is the safe direction. This decides whether owners categorize
their own data or request categories from whoever runs the adapters, so it is settled first.

## Relation to virtual cohorts

A local category and a cohort shared from Explore Data are both a filter over one study's records.
A category is named and reused by many grants; a cohort share carries its own filter, as a
[SQON-scoped grant](sqon-scoped-grants.md). Saving a cohort within one study as a local category
would settle that design's open question, whether a share means the records matching then or the
records matching now, since a category always means now. A cohort spanning studies is the separate
item on grouping records by more than one field.

## Why post-MVP, and what ships first

No flow in the first release has an owner creating a category, and `category.create` is seeded to
admins only. The conjunction above is a precondition as well.

**The prefix ships in the first release**, along with the scope beside each category's name in the
schema, so adding local categories later renames nothing. A first-release bridge accepts a
`resource.` entry, lets it reach nothing, and records it as `category.unenforced`, which is safe for
the principal holding it and nothing more: a local category also restricts its records, so no
resource may define one while an application serving it runs a bridge that only drops them. See
"Category names carry their scope from the first release" in
[decisions.md](../../../design/decisions.md).

**The onboarding document already announces it.** `docs/onboarding.md` states platform scope where
it matters, in the custodian section, says in the glossary that every first-release category is
platform-wide, and lists local categories under "What comes after the first release", so readers do
not take platform scope as permanent. Shipping it means moving that item into the body and saying,
for the first time there, who governs a local category.
