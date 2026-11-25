-- A principal's revocation names one of the identity revocation reasons, and the store refuses any other, so
-- every row names a reason the audit trail and the Management API can state.
ALTER TABLE principal_revocations ADD CONSTRAINT principal_revocations_reason_known CHECK (
  reason IN ('accountClosed', 'credentialCompromise', 'securityIncident', 'termsViolation')
);

-- A sign-out of everyone refuses every sign-in token issued before it. Its rows keep their table's grants, triggers
-- and positions under the new name; only the reasons narrow, since refusing earlier tokens answers neither a stolen
-- signing key nor a hijacked identity provider session.
ALTER TABLE global_revocations RENAME TO everyone_sign_outs;
ALTER TABLE everyone_sign_outs RENAME CONSTRAINT global_revocations_pkey TO everyone_sign_outs_pkey;
ALTER TABLE everyone_sign_outs RENAME COLUMN revoked_by TO signed_out_by;
ALTER TABLE everyone_sign_outs RENAME COLUMN revoked_at TO signed_out_at;
ALTER TABLE everyone_sign_outs DROP CONSTRAINT global_revocations_reason_code_check;
ALTER TABLE everyone_sign_outs ADD CONSTRAINT everyone_sign_outs_reason_known CHECK (
  reason_code IN ('credentialCompromise', 'securityIncident')
);
ALTER TABLE everyone_sign_outs RENAME CONSTRAINT global_revocations_revoked_by_fkey TO everyone_sign_outs_signed_out_by_fkey;

-- Its notice is a signOutEveryone notice, a name no category scope shares.
ALTER TABLE notices DROP CONSTRAINT notices_kind_check;
UPDATE notices SET kind = 'signOutEveryone' WHERE kind = 'global';
ALTER TABLE notices ADD CONSTRAINT notices_kind_known CHECK (
  kind IN ('baseline', 'category', 'principal', 'servedResources', 'signOutEveryone')
);

CREATE FUNCTION notify_everyone_sign_out() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
BEGIN
  PERFORM write_notice('signOutEveryone');
  RETURN NULL;
END
$$;

DROP TRIGGER write_notices ON everyone_sign_outs;
CREATE TRIGGER write_notices AFTER INSERT ON everyone_sign_outs
  FOR EACH ROW EXECUTE FUNCTION notify_everyone_sign_out();
DROP FUNCTION notify_global_revocation();
