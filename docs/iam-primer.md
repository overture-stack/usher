# Identity and Access Management: a primer

This document covers the background concepts that come up before Usher-specific design: what
happens when a user logs in, where the token comes from, what it contains, and how [authorization](concepts.md#authentication-vs-authorization)
services fit into that picture. It is intended for readers who are not yet familiar with OAuth 2.0,
[JWTs](concepts.md#jwts-signed-jws-vs-encrypted-jwe), or the standard roles in an access control system.

If you are already comfortable with these, skip directly to [intro.md](intro.md) or
[concepts.md](concepts.md).

---

## What happens when you log in

When a user signs into a platform, several things happen that are easy to conflate but are
distinct:

1. The user proves their identity to a trusted service (for example, by entering a password or
   using a federated login like an institutional account). This is **[authentication](concepts.md#authentication-vs-authorization)**.
2. That service issues a token: a structured piece of data that other services can inspect to
   confirm who the user is and what they are permitted to do. The token travels with subsequent
   requests.
3. When the user's application calls a data service, it includes that token. The data service
   checks the token rather than asking the user to log in again.

The service that handles step 1 and issues tokens is called the **identity provider (IdP)**.
In the Overture platform, Keycloak is the IdP. Users do not authenticate directly to Usher or
to data applications; they authenticate to Keycloak, and Keycloak issues the token.

---

## OAuth 2.0

OAuth 2.0 is the framework that defines how tokens are issued and used. It is a standard for
**authorization delegation**: a user grants an application permission to act on their behalf,
without giving the application their credentials.

The core participants in OAuth 2.0:

- **Resource owner:** the user.
- **Client:** the application acting on the user's behalf (for example, a data portal).
- **Authorization server:** the service that authenticates the user and issues tokens (Keycloak).
- **Resource server:** the service being accessed (a data API, Usher).

The most common flow for web applications is the **authorization code flow**: the user is
redirected to the authorization server, authenticates there, and the authorization server sends an
authorization code back to the client. The client exchanges that code for tokens. The user's
credentials never pass through the client.

OAuth 2.0 itself defines how tokens are issued and transported. It does not define what the tokens
contain or how they prove identity. That is the job of OpenID Connect.

> **Authoritative reference:** [oauth.net/2](https://oauth.net/2/) and
> [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749).

---

## OpenID Connect (OIDC)

OpenID Connect is a layer built on top of OAuth 2.0 that adds identity. Where OAuth 2.0 answers
"is this client authorized to act?", OIDC answers "who is the user this client is acting for?"

OIDC introduces the **ID token**: a signed token that contains claims about the user's identity.
Claims are key-value pairs: the user's identifier, their email address, the groups or roles they
belong to, when the token was issued, and when it expires.

OIDC also defines a **UserInfo endpoint**: an API the client can call (with an access token) to
retrieve additional claims about the user.

In practice, an OIDC identity provider like Keycloak issues two tokens after authentication:

- **ID token:** identity claims about the user. Intended for the client application.
- **Access token:** a credential the client sends to resource servers (APIs) to prove it is
  authorized to make a request. Resource servers validate this token rather than trusting the
  client's word.

Usher receives the access token on requests and validates it against Keycloak's public keys to
confirm the token is genuine and has not expired.

> **Authoritative reference:** [openid.net/connect](https://openid.net/connect/).

---

## JSON Web Tokens (JWTs)

Both the ID token and the access token issued by Keycloak are JWTs. A JWT is a compact, URL-safe
format for representing claims as a JSON object.

A JWT has three parts, separated by dots:

```
header.payload.signature
```

- **Header:** metadata about the token: the algorithm used to sign or encrypt it.
- **Payload:** the claims: the actual data the token carries.
- **Signature (or encryption):** a cryptographic value that lets receivers verify the token has
  not been tampered with (signed) or that only authorized parties can read it (encrypted).

**Standard claims in a JWT payload:**

| Claim | Meaning |
|---|---|
| `sub` | Subject: the unique identifier of the user |
| `iss` | Issuer: the authorization server that issued the token (Keycloak's URL) |
| `aud` | Audience: the intended recipient(s) of the token |
| `exp` | Expiry: a Unix timestamp after which the token must be rejected |
| `iat` | Issued at: when the token was created |
| `email`, `name`, etc. | Additional identity claims, set by the IdP |
| `groups`, `roles`, etc. | Membership claims, set by the IdP from its own user configuration |

Any service receiving a JWT must validate `iss` (expected issuer), `aud` (expected audience), and
`exp` (not expired) before trusting its contents. Accepting a token without validating these claims
is a common security error.

**Signed vs encrypted.** The Keycloak-issued tokens described above are signed ([JWS](concepts.md#jws-json-web-signature-signed-jwt)): anyone with
the public key can read the payload, and the signature proves the token was issued by Keycloak and
has not been modified. Usher's [grants tokens](concepts.md#grants-tokens) are encrypted ([JWE](concepts.md#jwe-json-web-encryption-encrypted-jwt)): only the intended recipient
(the enforcement plugin) can read the payload. This distinction matters because users forward their
access token with every request; if it were encrypted, they could not use it as a bearer credential.
The grants token is different: it contains the user's grants, which they should not be able to
read. See [concepts.md](concepts.md#jwts-signed-jws-vs-encrypted-jwe) for the full treatment.

> **Authoritative reference:** [jwt.io](https://jwt.io/) (interactive debugger and introduction)
> and [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519).

---

## Scopes

OAuth 2.0 uses **scopes** to limit what an access token permits. A scope is a string that
represents a specific permission: `openid` (include identity claims), `email` (include email
address), `profile` (include profile information), or application-defined scopes like
`data:read`.

The client requests scopes when initiating the authorization flow. The authorization server may
grant all, some, or none of them, depending on the user's permissions and any consent required.
The issued token carries the granted scopes.

Scopes are coarse: they express "this token is permitted to call this class of endpoint." They do
not express "this token's user is permitted to see these specific records." That finer distinction
is what Usher handles.

---

## Standard authorization roles

Access control systems consistently separate the same three responsibilities. These roles appear
in the Usher design and are worth knowing before reading the design documents:

- **[PDP](concepts.md#pdp-policy-decision-point) (Policy Decision Point):** the service that answers "what can this user see?" Given a
  validated identity, it consults the policy store and returns a decision or set of constraints.
  Usher is the PDP.
- **[PEP](concepts.md#pep-policy-enforcement-point) (Policy Enforcement Point):** the component that enforces the decision. It intercepts data
  requests, applies the constraints the PDP returned, and ensures the user only receives what they
  are permitted to see. In Usher, each application's plugin is the PEP.
- **[PAP](concepts.md#pap-policy-administration-point) (Policy Administration Point):** the interface through which administrators define and
  manage policy: who has access to what. Usher's management UI (planned) is the PAP.

These roles are always present in an access control system; the question is which software plays
each one. In a system without a dedicated authorization service, the application plays all three
itself, which is how enforcement drift starts.

See [concepts.md](concepts.md#the-four-abac-components) for more detail on these roles and the
fourth component, the [PIP](concepts.md#pip-policy-information-point).

---

## Further reading

- [oauth.net/2](https://oauth.net/2/): the OAuth 2.0 community site; readable introduction with
  links to RFCs and grant type explanations
- [openid.net/connect](https://openid.net/connect/): the OpenID Foundation's OIDC documentation
- [jwt.io](https://jwt.io/): JWT debugger (paste a token to inspect its contents) and
  introduction to the format
- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749): the OAuth 2.0 specification
- [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519): the JWT specification
- [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html): digital identity guidelines;
  the authoritative reference for authentication assurance levels and credential management

From here, [concepts.md](concepts.md) covers the authorization-specific vocabulary ([ABAC](concepts.md#rbac-vs-abac), the
[permissions model](concepts.md#the-permissions-model-entities), grants tokens, [fail-secure](concepts.md#fail-secure-vs-fail-open), [revocation](concepts.md#revocation-the-self-contained-token-problem)) in the depth needed to follow the
design documents.
