-- Department admins: a login ID next to the email, when the password was set, the last login, and the one admin of each department.
ALTER TABLE "users" ADD COLUMN "loginId" TEXT,
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
  ADD COLUMN "passwordChangedBy" TEXT,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- Existing accounts get a login ID from the part of the email before the @ (numbered when two share it)
UPDATE "users" u SET "loginId" = x.new_id
FROM (
  SELECT "id",
    base || CASE WHEN row_number() OVER (PARTITION BY base ORDER BY "createdAt") > 1 THEN (row_number() OVER (PARTITION BY base ORDER BY "createdAt"))::text ELSE '' END AS new_id
  FROM (SELECT "id", "createdAt", lower(regexp_replace(split_part("email", '@', 1), '[^a-zA-Z0-9._-]', '', 'g')) AS base FROM "users") b
) x
WHERE u."id" = x."id" AND x.new_id <> '';
CREATE UNIQUE INDEX "users_loginId_key" ON "users"("loginId");

ALTER TABLE "user_roles" ADD COLUMN "isDeptAdmin" BOOLEAN NOT NULL DEFAULT false;
-- at most one admin per department
CREATE UNIQUE INDEX "user_roles_one_dept_admin_per_role" ON "user_roles"("roleId") WHERE "isDeptAdmin";
