ALTER TABLE community_guild_link_requests
  ADD COLUMN requested_guild_kind text NOT NULL DEFAULT 'alliance',
  ALTER COLUMN alliance_abbreviation DROP NOT NULL,
  DROP CONSTRAINT community_guild_link_requests_alliance_abbreviation_check;

ALTER TABLE community_guild_link_requests
  ADD CONSTRAINT community_guild_link_requests_kind_check
    CHECK (requested_guild_kind IN ('state', 'alliance')),
  ADD CONSTRAINT community_guild_link_requests_alliance_abbreviation_check
    CHECK (
      (requested_guild_kind = 'alliance'
        AND alliance_abbreviation ~ '^[A-Z0-9]{3}$')
      OR (requested_guild_kind = 'state' AND alliance_abbreviation IS NULL)
    );

COMMENT ON COLUMN community_guild_link_requests.requested_guild_kind IS
  'Explicit requested topology kind. State requests never carry an alliance identity.';
