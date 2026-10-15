import bcrypt from "bcryptjs";
import { prisma } from "../src/common/lib/prisma";
import { recordAudit } from "../src/common/lib/audit";

/**
 * Last-resort password reset, for when the System Admin himself is locked out (nobody above him can reset it).
 * Run on the server:
 *
 *   npx tsx prisma/reset-user-password.ts <loginId or email> <newPassword>
 *
 * Sets the new password (min 10 characters), signs the person out everywhere and writes it in the audit log as done by SYSTEM.
 */
async function main() {
  const [who, newPassword] = process.argv.slice(2);
  if (!who || !newPassword) throw new Error("Usage: npx tsx prisma/reset-user-password.ts <loginId or email> <newPassword>");
  if (newPassword.length < 10) throw new Error("Password must be at least 10 characters");

  const user = await prisma.user.findFirst({
    where: { OR: [{ email: { equals: who.trim(), mode: "insensitive" } }, { loginId: who.trim().toLowerCase() }] },
  });
  if (!user) throw new Error(`No account with login ID or email "${who}"`);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 12), passwordChangedAt: new Date(), passwordChangedBy: "SYSTEM", tokenVersion: { increment: 1 } },
  });
  await recordAudit({ actorId: null, action: "user.password_reset", entityType: "User", entityId: user.id, metadata: { by: "SYSTEM script" } });
  console.log(`Password reset for ${user.fullName} (${user.loginId ?? user.email}). They are signed out everywhere.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
