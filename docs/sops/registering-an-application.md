# Registering an application

An application, such as one Arranger deployment, reaches Usher through its Bridge, and needs
registering once before its Bridge can start. You need to be a platform administrator.

**The answer to a registration holds two ids, and they go to different places.** Every mention of
one here names it by its place in the answer:

| In the answer | What it names                 | Where it goes                                                                                                                          |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | the application: its audience | the identity provider client's audience mapper, and the Bridge's `audience`                                                            |
| `key.id`      | that one key                  | revoking the key, telling keys apart in the application's listing, and the audit log; never the identity provider, a Bridge or a token |
| `key.value`   | the key itself                | the deployment's secret store, and from there the Bridge's `key`                                                                       |

1. **Register** with `POST /admin/applications`, sending its `displayName`, and a `description` if
   you want one. The answer is `201`, holding `id` at its root, and `key.id` and `key.value` under
   `key`.
2. **Store `key.value` at once** in the deployment's secret store. It appears in this answer alone,
   and the Controller never shows it again. If it is lost before it is stored, issue another with
   `POST /admin/applications/{applicationId}/keys` and revoke the lost one by its `key.id`.
3. **Put the root `id` in the identity provider**, so the application's sign-in tokens carry it in
   `aud`. In Keycloak, open the client the application signs people in through, then its dedicated
   scope, add an Audience mapper, and set Included Custom Audience to the root `id`, with Add to
   access token on.
4. **Configure the Bridge** with the root `id` as its `audience` and the stored `key.value` as its
   `key`, as the [Bridge's usage](../../modules/bridge--express/README.md#usage) describes. Neither
   takes `key.id`.
5. **Keep `key.id` for managing the key.** It is the `{keyId}` of
   `DELETE /admin/applications/{applicationId}/keys/{keyId}`, which revokes that key alone, where
   `{applicationId}` is the root `id`. `GET /admin/applications/{applicationId}` lists every key
   the application holds under `keys`, each by its `id` there, and the audit log names the key as
   `keyId` and the application as `applicationId`.
6. **Check** by signing in through the application's client and reading the access token: its `aud`
   holds the root `id`. Once the application starts, its Bridge's first exchange sets `confirmedAt`
   on the key in `GET /admin/applications/{applicationId}`.

A sign-in token whose `aud` lacks the root `id` is refused at the exchange, so the person signed in
with it reaches nothing beyond what an anonymous visitor does. The registration is recorded in the
audit log as `application.registration`, then `applicationKey.issuance`.
