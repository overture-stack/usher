# Responding to a compromised signing key

Follow this when the identity provider's signing key may be in someone else's hands. Whoever holds
it can sign a sign-in token for anyone, with any issue time, so it can reach every ushered
application and the Management API as any person, an administrator included.

**Rotating the key is what stops forged tokens**, and nothing in Usher replaces it. Signing everyone
out before the old key is gone stops nothing, since a forged token can carry an issue time later
than the sign-out.

1. **Add a new signing key.** In Keycloak's admin console, open the realm Usher trusts, then Realm
   settings, Keys, and add a key provider, such as rsa-generated, with a higher priority than the
   compromised one, so new tokens are signed with the new key.
2. **Remove the compromised key from the key set.** On the compromised key's provider, turn Enabled
   off, then delete the provider. A key that is only made passive is still published and still
   verifies tokens, so it must not stay published at all.
3. **Confirm the key set no longer lists it.** Read the `jwks_uri` named by the realm's discovery
   document, `/.well-known/openid-configuration` at the issuer, and check the compromised key's
   `kid` is absent.
4. **Make every Controller instance drop the old key.** The Controller trusts a key set it fetched
   for up to 10 minutes, so restart every Controller instance, or wait 10 minutes, before relying
   on the old key being refused.
5. **Sign everyone out**, following [Signing everyone out](signing-everyone-out.md) in full, with the
   reason `securityIncident`. Its notice drops every Usher token the Bridges hold, including any
   issued from a forged sign-in token before step 4.
6. **Review what was done in the window.** In the audit log, read the events from when the key may
   have been exposed until step 4: `token.exchange` for who reached which application, and every
   Management API change for who acted as an administrator, such as `admin.nomination`,
   `admin.nominationDecision`, `grant.creation`, `grant.revocation` and `settings.change`.
7. **Undo what a forged token did.** Remove an administrator who should not be one with
   `DELETE /admin/administrators/{subject}`, revoke a grant made in the window, and revoke a person
   who acted in it, following [Revoking and lifting a person](revoking-and-lifting-a-person.md).

Every other service that verifies the identity provider's tokens itself needs the same rotation,
outside Usher.
