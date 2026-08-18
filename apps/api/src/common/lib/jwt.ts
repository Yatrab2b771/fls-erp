import jwt from "jsonwebtoken";
import { env } from "./env";
import type { RoleName } from "@prisma/client";

export interface AccessTokenPayload {
  sub: string;
  roles: RoleName[];
  tokenVersion: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
}
