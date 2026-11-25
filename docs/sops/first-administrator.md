# Setting up the first administrator

Usher has no administrator when the Controller first starts. Until one accepts a nomination, the
Controller refuses every Management API operation with `403` `noAdministratorYet`, except the ones
these steps use. The health routes and the token exchange answer as usual.

**Before you start:** the seed file's `firstUser` names either a realm role, `usher-first-user` by
default, or one person's subject. See [The seed file](../deployment.md#the-seed-file).

1. **Make someone the first user.** Where `firstUser` names a realm role, a Keycloak administrator
   assigns that role to one person, in the realm's Users page, under Role mapping. Where it names a
   subject, nothing is configured in Keycloak. Give the role to one person only: whoever holds it can
   nominate.
2. **Find the nominee's subject.** It is the `sub` claim in the nominee's access token; in Keycloak,
   the user's ID in the realm Usher trusts, shown on that realm's Users page. The first user may
   nominate themself.
3. **The first user nominates** with `POST /admin/nominations`, sending
   `{ "nominee": { "subject": "<the subject>" } }`. The answer is the nomination, `pending`, and its
   `id` is the `nominationId` the nominee answers with. The nominee must be the first user, someone
   Usher already knows from an earlier sign-in, or, where the directory is configured, anyone with
   an account in the realm; otherwise the answer is `404` `nomineeNotFound`.
4. **The nominee accepts**, following [Accepting a nomination](accepting-a-nomination.md).
5. **Confirm** with `GET /admin/administrators`, which now lists the new administrator.
6. **Remove the first-user role** from whoever holds it. From the first acceptance on, it confers
   nothing, so keeping it only leaves a role nobody needs.

Until an administrator has accepted, the first user can follow every nomination with `GET
/admin/nominations`, and take back one still `pending` with `DELETE
/admin/nominations/{nominationId}`. Nominating again replaces the earlier nomination, and only the
latest can be accepted. The audit log records each step as `admin.nomination`, and the acceptance as
`admin.nominationDecision` at `critical`.

**Further administrators** are nominated the same way, by any administrator, with the same
`POST /admin/nominations`. See [Further administrators](../deployment.md#further-administrators).
