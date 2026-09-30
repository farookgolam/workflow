-- 029: each approver on the daily summary chooses the hour it arrives, in their own time zone.
--
-- Users.DigestHour 0-23 (NULL = the installation's DIGEST_HOUR). Users.DigestTimeZone is the IANA zone of the
-- browser they chose it from (e.g. America/New_York); NULL = server time, which is how 028 behaved. The summary job
-- works out "weekday, at or after that hour, not yet today" in that zone, and LastDigestOn is that zone's date.

ALTER TABLE Users ADD
  DigestHour TINYINT NULL CONSTRAINT CK_Users_DigestHour CHECK (DigestHour BETWEEN 0 AND 23),
  DigestTimeZone VARCHAR(64) NULL;
GO
