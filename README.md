# Usher

Usher is a standalone authorization service for the Overture platform. It answers "what is this
user allowed to see?" and returns structured constraints that each Overture application enforces
at the query layer, without a per-request call back to Usher.

Usher is not an authentication service. Authentication is delegated to the configured identity
provider (Keycloak, Azure Entra ID, or any OIDC-compatible provider).

> **Status: design phase.** No implementation exists yet. All current work is design and planning.
> See the [Design Index](.dev/design/README.md) for the documentation.

---

> Usher is part of [Overture](https://www.overture.bio/), a collection of open-source software
> microservices used to create platforms for researchers to organize and share genomics data.

## Documentation

Design documentation is in [.dev/design/](.dev/design/). The [Design Index](.dev/design/README.md)
covers what each document contains, its current status, and the recommended reading order.

No user-facing or operational documentation exists yet; the project has not reached the
implementation phase.

For internal contributor documentation (project structure, working documents, AI tooling, security
principles), see [DEVELOPMENT.md](DEVELOPMENT.md).

## Related software

Usher authorizes access to data managed by the rest of the Overture stack:

| Software | Description |
|---|---|
| [Score](https://github.com/overture-stack/score/) | Transfer data to and from any cloud-based storage system |
| [Song](https://github.com/overture-stack/song/) | Catalogue and manage metadata associated to file data spread across cloud storage systems |
| [Maestro](https://github.com/overture-stack/maestro/) | Organizing your distributed data into a centralized Elasticsearch index |
| [Arranger](https://github.com/overture-stack/arranger/) | A search API with reusable UI components |
| [Stage](https://github.com/overture-stack/stage) | A React-based web portal scaffolding |
| [Lyric](https://github.com/overture-stack/lyric) | A model-agnostic, tabular data submission system |
| [Lectern](https://github.com/overture-stack/lectern) | Schema Manager, designed to validate, store, and manage collections of data dictionaries |

## Support and contributions

Usher is not yet accepting external contributions; the project is in the design phase.

- Platform-level discussions: [Overture community support](https://docs.overture.bio/community/support)
- Contribution guidelines when available: [Contributing Guide](https://docs.overture.bio/docs/contribution)

## Funding acknowledgement

Overture is supported by grant #U24CA253529 from the National Cancer Institute at the US National
Institutes of Health, and additional funding from Genome Canada, the Canada Foundation for
Innovation, the Canadian Institutes of Health Research, Canarie, and the Ontario Institute for
Cancer Research.
