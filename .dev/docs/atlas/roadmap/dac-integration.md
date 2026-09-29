# A DAC API as an ushered application

Future scope, recorded as research ahead of the integration. Nothing here is in the first release,
and nothing here is decided beyond the direction in the first section.

## The direction

**A data access committee layer is its own ushered application, not part of Usher.** Usher stays
narrow, performant and stable: it stores no signed documents, no applicant details from
applications, and serves no API for a DAC interface. Usher governs who may review and who may approve
in the DAC service the same way it governs who may read in Arranger, and the DAC service asks Usher
to register resources and write grants once an application is approved.

This replaces an earlier expectation in `permissions-model.md`, that a request and a decision about
it would become control-plane entities in Usher's own model.

## Two flows

| Flow               | The committee approves                                 | What the DAC service then asks of Usher                                                                                |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Dataset onboarding | an application to bring a dataset onto the platform    | register the dataset as a resource, name its owner, and grant its submitters `submitter`, so Lyric accepts their uploads |
| Data access        | a researcher's application for an existing dataset     | grant the researcher a data-plane role on the dataset's categories, with an expiry                                     |

The second is the ethics-review-gated access with time-limited validity described in the roadmap's
DACO entry, and the `expires_at` column on `grants` is where its validity goes.

## The dataset onboarding flow, step by step

| Step | What happens                                                                                                                      | What a resource type does                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | Applications arrive at the DAC service as records of an `access-committee` resource, one per committee                               | The resource has type `access-committee`, so no Arranger or Lyric token names it and no dataset list shows it        |
| 2    | Reviewers and approvers hold roles on the committee's resource                                                                            | Only roles that make sense on an `access-committee` resource can be granted there                                       |
| 3    | An application is approved; the DAC service's account asks Usher to register HEART_STUDY and name X owner, Y and Z submitters     | The DAC service's account may register only `dataset` resources, which bounds what a compromised account does |
| 4    | Lyric's token for Y names HEART_STUDY with `record.create`                                                                        | `dataset` resources are served by Lyric, Arranger and Score                                                 |
| 5    | A researcher later applies to the DAC for access to HEART_STUDY's data                                                            | If the DAC service also serves `dataset`, its tokens name HEART_STUDY, and a reviewer role there carries only capabilities on applications |

**What the model already handles.** Capabilities belong to entities, so a role carrying a capability
on applications means nothing to Arranger, even on a resource served by both services. What it does
not yet hold is which resources each service sees at all (steps 1 and 4) and which resources a
service may register (step 3).

## Resources come in types

**What a type does.** Three things, all missing today:

1. **Which ushered applications serve a resource.** `decisions.md` says the controller already knows
   which audiences serve which resources, and the token calculation has a case that depends on it,
   but nothing in the schema holds that knowledge. A type, with each application declaring the types
   it serves, is where it would live.
2. **Which roles and categories can be granted on a resource.** A `submitter` grant on a committee is
   meaningless, and a type lets it be refused at writing.
3. **Which resources a service account may register.** The containment for the threat below.

**Its shape, as proposed.** One type per resource, set at registration and never changed afterwards,
since changing it changes which services see the resource, which is a re-registration rather than an
edit. Each ushered application declares the types it serves. Overture seeds the vocabulary for every
platform, the way it seeds roles, so the values are generic rather than one platform's words.

**The values name what a resource is, never the service serving it.** One dataset is served by
several services at once: its metadata by a search service, its submissions by a submission service,
its files by a file service, and applications for access to it by a DAC service. A type named after
one of them would force the dataset to be registered once per service, with every grant written and
revoked once per copy, and Usher exists to prevent that drift between applications. What a service
does decides which types it declares, not what the types are called.

| Value              | What the resource is                                     | Served by                                  | Arrives                |
| ------------------ | -------------------------------------------------------- | ------------------------------------------ | ---------------------- |
| `dataset`          | a body of research data, DCAT's `dcat:Dataset`            | search, submission and file services       | the first release      |
| `access-committee` | the applications one data access committee handles       | the DAC service                            | with the integration   |

Two candidates were rejected. **`study`** is one platform's word, and domain terms are instance
vocabulary, kept out of Usher's model. **`files`** would split a dataset from its own files: two
resources, two grants to reach both, and a revocation of one leaving the other reachable. A
dataset's files belong to the dataset, and the file service serving them is what separates them, as
it does today. A type for files would fit only files that belong to no dataset.

Values are lowercase, like every identifier in the model.

**The onboarding document keeps "dataset" as its word for every resource.** It will not cover the
DAC integration, so its everyday sense and the type's never meet in one reader's context.

**Not in the first release.** Every resource there is one type. The type changes which resources a
token names rather than the token's shape, so adding it later is a column with a default rather than
a payload version.

## The name: DCAT's word is type

The DCAT decision in `decisions.md` says DCAT's meaning governs where Usher uses a DCAT-defined
word, so the name was checked against it on 2026-09-28.

- **DCAT 3** (W3C Recommendation, 22 August 2024) gives `dcat:Resource` the property `dcterms:type`,
  "The nature or genre of the resource", with `rdfs:Class` as its range. It recommends values from
  well-governed controlled vocabularies: the DCMI Type vocabulary, ISO 19115-1 scope codes, DataCite
  resource types, re3data.org content types and MARC intellectual resource types.
- **Dublin Core** defines `dcterms:type` the same way and recommends the DCMI Type Vocabulary.

So **type** is the aligned word, and "kind" would be an invented synonym for it. Two consequences:

- The values are a controlled vocabulary, seeded by Overture for every platform as it seeds roles.
- The word needs a glossary entry separating it from Arranger's `documentType` and from a type in
  code.

**`dcat:theme` is not this property.** It is "a main category of the resource", and a resource can
have several. It is about subject matter rather than what kind of thing a resource is. It is also
DCAT's use of the word category, which differs from Usher's, and the DCAT decision does not yet
record that collision.

## The ownership-assignment threat

**Step 3 is a service writing a control-plane grant.** `admin-model.md` already warns that a
compromised service account holding `grant.create` could make a malicious actor the owner of any newly
created resource, and names a service account that may write only data-plane grants as the
containable form. Study onboarding needs the uncontained form, since it names an owner. Mitigations to
design with the integration:

- A service registers only the resource types it is allowed.
- Every ownership assignment made by a service records which approved application justified it.
- Possibly, an administrator confirms a service-assigned owner before it takes effect.

The data access flow needs only data-plane grants, which is the containable form already described.

## New entities, and so a payload version

Applications are data-plane records of the DAC service, held within an `access-committee` resource,
so `application` is a new data-plane entity, with actions such as viewing, reviewing and approving.

**An applicant reaching only their own applications needs selection relative to the person asking.**
A reviewer holds one grant on the committee's resource and reaches all of its applications. An
applicant has to reach only the ones they submitted, which is a record selected by who asks rather
than by a fixed value, the post-MVP narrowing recorded in `permissions-model.md` as
principal-relative selection. It is a prerequisite for this integration, unless the DAC service
shows applicants their own applications without Usher deciding it.

How the signed documents are modelled, as a part of an application or as an entity of their own, is
open; either way the DAC service stores them and Usher does not. A new data-plane entity changes
what a token carries, which is a payload version and a coordinated deploy, and it arrives with the
integration.

## REMS, before building one

REMS already does applications, approval workflows and licences. It sends each entitlement to a
configured endpoint and can issue signed GA4GH visas. It is MIT licensed and maintained, with v2.39.1
released in April 2026. Whether the DAC API is built or REMS is ushered is a decision for the
integration; the Usher side is the same either way.

## Open questions

- Where each application's declaration of the types it serves lives: instance configuration or a
  table.
- What groups applications into a DAC resource: a committee, a programme or something else, and which
  field of the DAC service's records carries it.
- Whether a service-assigned owner needs an administrator's confirmation.
- Which roles the DAC service needs, such as reviewer and approver, and which actions on applications
  each carries.

## Sources, checked 2026-09-28

- DCAT 3: <https://www.w3.org/TR/vocab-dcat-3/>, <https://www.w3.org/ns/dcat3.ttl>
- Dublin Core `type`: <https://www.dublincore.org/specifications/dublin-core/dcmi-terms/terms/type/>
- REMS: <https://github.com/CSCfi/rems>, <https://github.com/CSCfi/rems/blob/master/docs/ga4gh-visas.md>
