# Revoking and lifting a person

Revoking a person acts in Usher alone: every ushered application refuses them, whatever credential
they present, while the revocation stands. Their grants are kept, so lifting it restores them as
they were. It ends no session at the identity provider and does not disable the account there. A
service that accepts API keys without going through Usher is not reached by it: cut the person's
keys off there as your deployment's own break-glass procedure describes.

## Revoking

1. **Find the person's subject**: the `sub` claim in their access token; in Keycloak, the user's ID
   in the realm Usher trusts, shown on that realm's Users page. Usher accepts a subject it has never
   met, and answers `seenBefore: false`.
2. **Choose the reason**: `accountClosed`, `credentialCompromise`, `securityIncident` or
   `termsViolation`.
3. **Revoke** with `POST /admin/people/revocations`, sending
   `{ "subject": "<the subject>", "reason": "<the reason>" }`. The answer is `201`, with the
   subject, the reason, the instant of the revocation and `seenBefore`.
    - `409` `alreadyRevoked`: a revocation of the person already stands.
    - `409` `lastAdministrator`: the person is the only administrator not revoked. Nominate another
      and have them accept first.
4. **Expect it to take hold** at once at the exchange, and at each application as its Bridge
   receives the notice naming the person and drops the tokens it holds for them.

An administrator who is revoked stays in `GET /admin/administrators`, marked `revoked: true`, and
no longer counts as an administrator until the revocation is lifted. The revocation is recorded as
`identity.revocation`, at `critical`.

## Lifting

1. **Lift** with `POST /admin/people/revocations/lifts`, sending `{ "subject": "<the subject>" }`.
   The answer is `200`, with the instant of the revocation and of the lift. `409` `notRevoked`
   means no revocation of the person stands.
2. **Have the person sign in again.** A sign-in token issued at or before the lift is still
   refused, so access returns only with a fresh sign-in. A sign-out recorded since the revocation
   still applies.
3. **Have the person get new API keys.**

The lift is recorded as `identity.revocationLift`, at `critical`.
