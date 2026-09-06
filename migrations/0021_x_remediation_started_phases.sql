ALTER TABLE "x_remediation_journals"
  DROP CONSTRAINT "x_remediation_journals_phase_check";
ALTER TABLE "x_remediation_journals"
  ADD CONSTRAINT "x_remediation_journals_phase_check"
  CHECK ("phase" IN ('prepared', 'delete_started', 'deleted', 'replacement_started', 'replaced', 'verified'));
ALTER TABLE "x_remediation_journals" ADD COLUMN "delete_started_at" timestamp with time zone;
ALTER TABLE "x_remediation_journals" ADD COLUMN "replacement_started_at" timestamp with time zone;
