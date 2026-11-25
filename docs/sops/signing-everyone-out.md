# Signing everyone out

Sign everyone out when sign-in tokens may have leaked but the identity provider's sessions and
signing keys have not. Usher then refuses every sign-in token issued before the sign-out, at every
application, and every Bridge drops every Usher token it holds. Every grant is kept.

A sign-out of everyone ends no session at the identity provider. A session still live there, or a
refresh token, gets a fresh sign-in token issued after the sign-out, which Usher accepts. So it does
not stop a stolen refresh token, a hijacked provider session or a stolen signing key on its own;
step 1 deals with the sessions, and a stolen signing key has
[its own SOP](identity-provider-key-compromise.md).

**Do the steps in this order.** Recorded first, the sign-out leaves every provider session open
until step 1 ends it, and a hijacked session can get a fresh sign-in token in between. That token
was issued after the sign-out, so Usher accepts it until it expires.

1. **End every session at the identity provider.** In Keycloak's admin console, open the realm
   Usher trusts, then Sessions, and choose Sign out all active sessions; through the admin API, it
   is `POST /admin/realms/{realm}/logout-all`. Where clients use offline access, end those offline
   sessions too: an offline token obtains fresh access tokens without an active session.
2. **Sign everyone out in Usher** with `POST /admin/sign-outs`, sending
   `{ "confirm": true, "reason": "<the reason>" }`, the reason `credentialCompromise` or
   `securityIncident`. The answer is `201`, with the reason and `signedOutAt`, the instant from
   which sign-in tokens are accepted again.
3. **Expect everyone to sign in again**, administrators included. Each fresh sign-in is accepted.

The sign-out is recorded as `identity.signOutEveryone`, at `critical`. It cannot be lifted: tokens
issued before it stay refused.
