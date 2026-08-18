import bcrypt from "bcryptjs";
import { prisma } from "../../src/common/lib/prisma";
import { signAccessToken } from "../../src/common/lib/jwt";
import { RoleName } from "@prisma/client";

let counter = 0;

/** Creates a real user row with the given roles and a matching bearer token — bypasses HTTP for speed since login itself is covered separately. */
export async function createUser(roles: RoleName[] = []) {
  counter += 1;
  const email = `test-user-${counter}@fls.test`;
  const passwordHash = await bcrypt.hash("TestPassword123", 10);
  const user = await prisma.user.create({ data: { email, passwordHash, fullName: `Test User ${counter}` } });

  for (const name of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  const token = signAccessToken({ sub: user.id, roles, tokenVersion: user.tokenVersion });
  return { user, token, email, password: "TestPassword123" };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}
