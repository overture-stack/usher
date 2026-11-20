# GA4GH Passports and federated identity

An integration path Usher does not implement: how an instance would honour access approvals issued
outside it, carried as GA4GH Passport claims. The open gaps are in `.dev/roadmap.md`, § GA4GH Passport
integration: three gaps.

This document covers an optional integration path. Some instances manage all grants internally,
through the Management API or a local approval workflow. They do not need Passport support. Passport
integration is relevant when researchers hold access approvals issued by institutions outside the
instance. Those approvals then need to be honoured automatically.

The scenario: a researcher at one institution holds a data access approval. It was issued by a data
access committee at a different institution. Those two institutions do not share identity
infrastructure. Without a shared standard, each data holder must establish a direct trust
relationship with each approving institution. That does not scale.

GA4GH (Global Alliance for Genomics and Health) is an international standards body. Its
**Passport** specification defines a standard format for expressing access claims inside OIDC
tokens. Specifically, it defines a structured JWT claim (`ga4gh_passport_v1`), and any
OIDC-compliant identity system can carry it. It is not a new protocol. It is a defined schema for
access grants inside tokens you already use.

### Visa types

A Passport contains one or more **Visas**: individual signed claim assertions. The types
relevant to Overture:

| Visa type                  | What it asserts                                                             |
| -------------------------- | --------------------------------------------------------------------------- |
| `ControlledAccessGrants`   | Researcher is granted dataset X, access type Y, until date Z                |
| `AcceptedTermsAndPolicies` | Researcher accepted data use agreement B                                    |
| `AffiliationAndRole`       | Researcher is affiliated with institution A in role R                       |
| `ResearcherStatus`         | Researcher holds bona fide researcher status, for example ELIXIR Researcher |

`ControlledAccessGrants` is the visa type that maps directly to Usher's Controlled access tier. A
data access committee's approval for a specific dataset is the external origin of a category grant.

### The three roles in a Passport ecosystem

Different parties in a Passport-enabled ecosystem play distinct roles:

| Role                | What it does                                                           | Examples                             |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| **Visa Issuer**     | Signs and issues individual Visa assertions after a grant event        | REMS, ELIXIR AAI, institutional DACs |
| **Passport Broker** | Aggregates Visas from multiple Issuers into a single Passport          | LifeScience Login, ELIXIR Login      |
| **Clearinghouse**   | Validates incoming Passports and maps approved claims to access grants | Usher, via Keycloak                  |

The examples above are real services you may meet in this space. REMS is the Resource Entitlement
Management System from CSC Finland. ELIXIR is Europe's life-science data
infrastructure, and ELIXIR AAI is its authentication and authorization service. GHGA, mentioned
later, is the German Human Genome-Phenome Archive. A data access committee is the group that
reviews and approves researcher applications.

Usher plays the Clearinghouse role. It does not validate Passport signatures itself: that belongs
to the identity layer, which validates each Visa's signature against the issuer's public JWKS
endpoint, checks the issuer against a configured trusted-issuers list, verifies expiry, and maps
validated claims to token attributes. Usher reads those attributes and maps them to
`grants` in its policy store. Which component performs that validation for a given
instance is an integration choice rather than a settled part of this design. The per-app PEP adapters see only
the Usher token. They do not know whether a grant came from an internal admin action or an
external Passport Visa.

### The flow

    Researcher obtains Visas from an external data access committee via REMS or similar
      -> Passport Broker (LifeScience Login / ELIXIR) bundles them into a Passport
      -> Researcher authenticates to Keycloak with their Passport
      -> Keycloak (GA4GH Passport extension):
           validates each Visa signature against issuer JWKS
           checks issuer against trusted-issuers list
           maps ControlledAccessGrants claims to Keycloak token attributes
      -> Usher reads Keycloak attributes, maps to grants
      -> Usher issues JWE Usher token
      -> PEP adapter enforces it as normal (unchanged)
