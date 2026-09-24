-- V9 P0: refresh tokens must map to exactly one persisted session.
-- Abort migration if duplicate refresh token hashes already exist.
SET @duplicate_refresh_hashes := (
  SELECT COUNT(*)
  FROM (
    SELECT `refreshTokenHash`
    FROM `auth_sessions`
    GROUP BY `refreshTokenHash`
    HAVING COUNT(*) > 1
  ) AS duplicate_hash_groups
);

SET @abort_sql := IF(
  @duplicate_refresh_hashes > 0,
  'SIGNAL SQLSTATE ''45000'' SET MESSAGE_TEXT = ''Duplicate refreshTokenHash rows exist; resolve before adding UNIQUE constraint''',
  'SELECT 1'
);

PREPARE abort_stmt FROM @abort_sql;
EXECUTE abort_stmt;
DEALLOCATE PREPARE abort_stmt;

DROP INDEX `auth_sessions_refreshTokenHash_idx` ON `auth_sessions`;
CREATE UNIQUE INDEX `auth_sessions_refreshTokenHash_key` ON `auth_sessions`(`refreshTokenHash`);