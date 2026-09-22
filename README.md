# Usher

Usher is the access control plane for the Overture platform. It holds the grants that say what each
person may see and do, hands them to each application, and gives the people who govern access one
place to change them. It is
closer to a keychain than a lock, with the keys handed to each application rather than to the person
asking: enforcement happens inside the application at its own query layer, with no per-request call
back to Usher.

Two things separate it from a conventional access control service. It governs **who may grant**, not
only who may read, so a category's custodian holds authority over that category across every dataset
while holding no access to any of it. And it **fails closed**: an application that loses contact with
Usher stops serving the affected data rather than coasting on its cache.

Usher is not an authentication service. Authentication is delegated to the configured identity
provider (Keycloak, Microsoft Entra ID, or any OIDC-compatible provider).

<br/>

<!-- > <img align="left" src="ov-logo.png" height="50"/> -->

> _Usher is part of [Overture](https://www.overture.bio/), a collection of open-source software microservices used to create platforms for researchers to organize and share genomics data._

---

## Documentation

> **Status: design phase.** No implementation exists yet. All current work is design and planning.
> See the [Design Index](.dev/design/README.md) for the corresponding documentation.

Operational documentation waits on implementation. What exists now explains the problem and the
model:

| Document | For |
| --- | --- |
| [Onboarding](docs/onboarding.md) | A plain-language orientation to the model and the reasoning behind it, written for readers who are not engineers. Rendered and published as a shared page; the file itself is the source |
| [Data access control](docs/intro.md) | The problem and the patterns, before the design detail |
| [Why Usher](docs/why-usher.md) | Why a separate service, rather than access logic inside each application |
| [Concepts and vocabulary](docs/concepts.md) | ABAC terms, security primitives, and the permissions model entities |
| [IAM primer](docs/iam-primer.md) | Login, tokens and access control basics, for readers meeting them for the first time |

For internal contributor documentation (project structure, working documents, AI tooling, security
principles), see [DEVELOPMENT.md](DEVELOPMENT.md).

## Related software

The Overture platform includes the following components:

<br/>

| Software                                                | Description                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Score](https://github.com/overture-stack/score/)       | Transfer data to and from any cloud-based storage system                                  |
| [Song](https://github.com/overture-stack/song/)         | Catalogue and manage metadata associated to file data spread across cloud storage systems |
| [Maestro](https://github.com/overture-stack/maestro/)   | Organizing your distributed data into a centralized Elasticsearch index                   |
| [Arranger](https://github.com/overture-stack/arranger/) | A search API with reusable UI components                                                  |
| [Stage](https://github.com/overture-stack/stage)        | A React-based web portal scaffolding                                                      |
| [Lyric](https://github.com/overture-stack/lyric)        | A model-agnostic, tabular data submission system                                          |
| [Lectern](https://github.com/overture-stack/lectern)    | Schema Manager, designed to validate, store, and manage collections of data dictionaries  |

If you'd like to get started using our platform [check out our quickstart guides](https://docs.overture.bio/guides/getting-started)

## Support and contributions

Usher is not yet accepting external contributions; the project is in the design phase.

- Platform-level discussions: [Overture community support](https://docs.overture.bio/community/support)
- Contribution guidelines when available: [Contributing Guide](https://docs.overture.bio/docs/contribution)

## Funding acknowledgement

Overture is supported by grant #U24CA253529 from the National Cancer Institute at the US National Institutes of Health, and additional funding from Genome Canada, the Canada Foundation for
Innovation, the Canadian Institutes of Health Research, Canarie, and the Ontario Institute for Cancer Research.
