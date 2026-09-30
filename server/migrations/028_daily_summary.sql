-- 028: approvers can choose one summary email each morning instead of an email per request.
--
-- Users.EmailDigest = 1: "Approval needed", "Resubmitted", "Reassigned" and scheduled "Reminder" emails are not sent
-- to this person; instead the sweeper sends one "requests waiting for your approval" summary on weekday mornings
-- (DIGEST_HOUR, server time) when anything is waiting. Users.LastDigestOn is the server-local date it last ran for
-- them, so each person gets at most one a day. Chosen by the person on their account page.

ALTER TABLE Users ADD
  EmailDigest BIT NOT NULL CONSTRAINT DF_Users_EmailDigest DEFAULT 0,
  LastDigestOn DATE NULL;
GO
