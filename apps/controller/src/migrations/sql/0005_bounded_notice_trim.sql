-- A trim of the notice stream deleting at most a given number of notices in one call, so the work of
-- one call stays bounded however far the stream has grown.

-- Deletes the notices older than the retention floor, through the highest position below every
-- notice younger than it, and no further than the highest position among the oldest max_rows of
-- them; raises the watermark to that position in the same transaction, and returns it. The floor is
-- read from the store, so a trim cannot be handed a lower one, and the watermark never moves down.
-- With no notice left at or below the watermark, the notices through that position are those
-- max_rows alone. A max_rows below 1, or none, is refused. It runs as the schema's owner, since the
-- controller's role may neither delete notices nor move the watermark itself.
CREATE FUNCTION trim_notices(max_rows integer) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $$
DECLARE
  watermark bigint;
  cutoff timestamptz;
  first_kept bigint;
  reach bigint;
BEGIN
  IF max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'a bounded trim deletes at most max_rows notices, which must be at least 1'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT trimmed_through INTO watermark FROM notice_stream FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the notice stream holds no row, so no trim can record its reach'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT now() - make_interval(secs => floor_seconds) INTO cutoff FROM notice_retention;
  SELECT min(position) INTO first_kept FROM notices WHERE created_at >= cutoff;
  SELECT max(oldest.position) INTO reach FROM (
    SELECT position FROM notices
     WHERE created_at < cutoff AND (first_kept IS NULL OR position < first_kept)
     ORDER BY position
     LIMIT max_rows
  ) oldest;
  reach := greatest(watermark, reach);
  DELETE FROM notices WHERE position <= reach;
  UPDATE notice_stream SET trimmed_through = reach WHERE trimmed_through <> reach;
  RETURN reach;
END
$$;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA :"schema" FROM PUBLIC;

GRANT EXECUTE ON FUNCTION trim_notices(integer) TO :"runtime_role";
