import { prisma } from "./prisma";
import type { RoleName } from "@prisma/client";

interface NotifyContent {
  title: string;
  body?: string;
  /** Frontend route to open when the notification is clicked, e.g. "/inventory" or "/batches/abc-123". */
  link?: string;
}

/**
 * Fans a notice out to every active user holding any of the given
 * roles — one row per recipient, same append-only spirit as
 * recordAudit. ADMIN is never implicitly included; departments each
 * get exactly what's addressed to their role, not a copy of everything.
 * `excludeUserId` skips notifying the actor about their own action
 * (e.g. Store doesn't need "material logged" for the entry they just logged).
 */
export async function notifyRoles(roles: RoleName[], content: NotifyContent, excludeUserId?: string): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: {
      isActive: true,
      roles: { some: { role: { name: { in: roles } } } },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true },
  });
  if (!recipients.length) return;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({ recipientId: r.id, title: content.title, body: content.body, link: content.link })),
  });
}

/** Notifies one specific person — e.g. telling a requester their Material Request was approved. */
export async function notifyUser(recipientId: string, content: NotifyContent): Promise<void> {
  await prisma.notification.create({ data: { recipientId, title: content.title, body: content.body, link: content.link } });
}
