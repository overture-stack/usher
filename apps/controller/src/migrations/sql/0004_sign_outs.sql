-- Sign-outs relayed from the identity provider, and the sessions sign-in exchanges carried. A sign-out is
-- kept until the longest a sign-in token it concerns may live has passed, measured by the sign-in token
-- maximum in force when it was recorded.

-- A sign-out relayed by session: a sign-in token carrying that `sid` is refused. The subject is
-- empty when the logout named only the session and no exchange had carried it.
CREATE TABLE sid_sign_outs (
  idp_issuer text NOT NULL,
  sid text NOT NULL,
  idp_subject_id text,
  signed_out_at timestamptz NOT NULL,
  -- The sign-out plus the sign-in token maximum in force when it was recorded. A sign-in token is judged
  -- against the smallest maximum in force since it was issued, so raising the maximum admits no token a
  -- sign-out was kept for.
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (idp_issuer, sid)
);

-- A sign-out relayed for a subject whose tokens carry no `sid`: a sign-in token of that subject
-- issued before the sign-out is refused.
CREATE TABLE subject_sign_outs (
  idp_issuer text NOT NULL,
  idp_subject_id text NOT NULL,
  signed_out_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (idp_issuer, idp_subject_id)
);

-- Each `sid` a sign-in exchange carried, so a logout naming only the session reaches its subject;
-- kept no longer than that sign-in token lives.
CREATE TABLE exchanged_sids (
  idp_issuer text NOT NULL,
  sid text NOT NULL,
  idp_subject_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (idp_issuer, sid)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sid_sign_outs, subject_sign_outs, exchanged_sids TO :"runtime_role";
