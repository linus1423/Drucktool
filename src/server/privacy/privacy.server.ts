// Datenschutz (Issue #26): Anonymisieren statt Löschen und Datenauskunft nach Art. 15 DSGVO.
import { and, asc, count, eq, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.server'
import { writeAudit } from '../audit/audit.server'
import { forgetRateLimits } from '../auth/rate-limit.server'
import { removeStored } from '../files/storage.server'
import { scrubAuditLog } from '../maintenance/cleanup.server'
import type { Principal } from '../requests/requests.server'

const {
  users,
  organisations,
  sessions,
  oidcAccounts,
  loginTokens,
  emailOutbox,
  requests,
  requestComments,
  requestEvents,
  requestFiles,
  auditLog,
} = schema

export const ANONYMOUS_NAME = 'Gelöschter Nutzer'

/** Platzhalter-Adresse. .invalid ist reserviert und kann nie zugestellt werden; die echte Adresse ist wieder frei. */
export function anonymousEmail(userId: string) {
  return `geloescht-${userId}@anonym.invalid`
}

/**
 * Entfernt alle personenbezogenen Daten eines Kontos. Aufträge, Kommentare und an Aufträgen
 * hängende Dateien bleiben wegen der Aufbewahrungspflichten erhalten und zeigen dann
 * „Gelöschter Nutzer“. Die Rechnungs- und Lieferadresse, die beim Absenden als Kopie am
 * Auftrag gespeichert wurde, gehört zum Auftrag und bleibt ebenfalls.
 */
export async function anonymizeUser(actor: Principal, userId: string) {
  const storageKeys = await getDb().transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
    if (!user) throw new Error('Benutzer nicht gefunden')
    if (user.anonymizedAt) throw new Error('Dieses Konto wurde bereits anonymisiert')
    if (user.id === actor.id) throw new Error('Sie können Ihr eigenes Konto nicht anonymisieren')
    if ((user.role === 'admin' || user.role === 'superadmin') && actor.role !== 'superadmin') {
      throw new Error('Nur ein Superadmin darf Administratoren verwalten')
    }
    if (user.role === 'superadmin' && user.status === 'active') {
      const [others] = await tx
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'superadmin'), eq(users.status, 'active'), ne(users.id, user.id)))
      if ((others?.n ?? 0) === 0) throw new Error('Der letzte aktive Superadmin kann nicht entfernt werden')
    }
    const email = user.email.toLowerCase()

    await tx
      .update(users)
      .set({
        name: ANONYMOUS_NAME,
        email: anonymousEmail(user.id),
        passwordHash: null,
        status: 'disabled',
        organisationId: null,
        billingAddress: null,
        deliveryAddress: null,
        emailNotifications: false,
        lastLoginAt: null,
        anonymizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
    // Ohne Sitzungen und OIDC-Verknüpfung kommt niemand mehr in dieses Konto.
    await tx.delete(sessions).where(eq(sessions.userId, user.id))
    await tx.delete(oidcAccounts).where(eq(oidcAccounts.userId, user.id))
    await tx.delete(loginTokens).where(sql`lower(${loginTokens.email}) = ${email}`)
    await tx.delete(emailOutbox).where(sql`lower(${emailOutbox.to}) = ${email}`)
    await forgetRateLimits(email, tx)
    await scrubAuditLog(tx, [user.id], [email])
    // Hochgeladene, aber nie abgeschickte Dateien gehören zu keinem Auftrag und können weg.
    const files = await tx
      .delete(requestFiles)
      .where(and(eq(requestFiles.ownerId, user.id), isNull(requestFiles.requestId)))
      .returning({ key: requestFiles.storageKey })

    await writeAudit(tx, {
      actorId: actor.id,
      action: 'user.anonymized',
      targetType: 'user',
      targetId: user.id,
      data: { role: user.role, removedFiles: files.length },
    })
    return files.map((f) => f.key)
  })
  // Erst nach dem Commit die Dateien von der Platte löschen.
  await Promise.all(storageKeys.map((key) => removeStored(key).catch(() => undefined)))
}

/** Alles, was das Tool zu einer Person gespeichert hat, als JSON (Art. 15 DSGVO). */
export async function exportUserData(actor: Principal, userId: string) {
  const db = getDb()
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      status: users.status,
      organisationId: users.organisationId,
      organisationName: organisations.name,
      emailNotifications: users.emailNotifications,
      billingAddress: users.billingAddress,
      deliveryAddress: users.deliveryAddress,
      hasPassword: sql<boolean>`${users.passwordHash} is not null`,
      reviewedAt: users.reviewedAt,
      lastLoginAt: users.lastLoginAt,
      anonymizedAt: users.anonymizedAt,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .leftJoin(organisations, eq(organisations.id, users.organisationId))
    .where(eq(users.id, userId))
  if (!user) throw new Error('Benutzer nicht gefunden')
  const email = user.email.toLowerCase()

  const [activeSessions, linkedAccounts, ownRequests, comments, events, files, audit, mails] = await Promise.all([
    db
      .select({
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(asc(sessions.createdAt)),
    db
      .select({ issuer: oidcAccounts.issuer, subject: oidcAccounts.subject, createdAt: oidcAccounts.createdAt })
      .from(oidcAccounts)
      .where(eq(oidcAccounts.userId, userId)),
    db
      .select({
        number: requests.number,
        title: requests.title,
        description: requests.description,
        status: requests.status,
        quantity: requests.quantity,
        desiredDate: requests.desiredDate,
        order: requests.order,
        totalCents: requests.totalCents,
        billingAddress: requests.billingAddress,
        deliveryMethod: requests.deliveryMethod,
        deliveryAddress: requests.deliveryAddress,
        termsAcceptedAt: requests.termsAcceptedAt,
        termsVersion: requests.termsVersion,
        createdAt: requests.createdAt,
        updatedAt: requests.updatedAt,
      })
      .from(requests)
      .where(eq(requests.createdById, userId))
      .orderBy(asc(requests.number)),
    db
      .select({
        requestNumber: requests.number,
        body: requestComments.body,
        internal: requestComments.internal,
        createdAt: requestComments.createdAt,
      })
      .from(requestComments)
      .innerJoin(requests, eq(requests.id, requestComments.requestId))
      .where(eq(requestComments.authorId, userId))
      .orderBy(asc(requestComments.createdAt)),
    db
      .select({
        requestNumber: requests.number,
        type: requestEvents.type,
        fromStatus: requestEvents.fromStatus,
        toStatus: requestEvents.toStatus,
        createdAt: requestEvents.createdAt,
      })
      .from(requestEvents)
      .innerJoin(requests, eq(requests.id, requestEvents.requestId))
      .where(eq(requestEvents.actorId, userId))
      .orderBy(asc(requestEvents.createdAt)),
    db
      .select({
        filename: requestFiles.filename,
        sizeBytes: requestFiles.sizeBytes,
        mimeType: requestFiles.mimeType,
        sha256: requestFiles.sha256,
        requestNumber: requests.number,
        createdAt: requestFiles.createdAt,
      })
      .from(requestFiles)
      .leftJoin(requests, eq(requests.id, requestFiles.requestId))
      .where(eq(requestFiles.ownerId, userId))
      .orderBy(asc(requestFiles.createdAt)),
    db
      .select({
        action: auditLog.action,
        data: auditLog.data,
        ip: auditLog.ip,
        createdAt: auditLog.createdAt,
        byThisUser: sql<boolean>`${auditLog.actorId} is not distinct from ${userId}::uuid`,
      })
      .from(auditLog)
      .where(
        or(
          eq(auditLog.actorId, userId),
          and(eq(auditLog.targetType, 'user'), eq(auditLog.targetId, userId)),
          sql`lower(${auditLog.data}->>'email') = ${email}`,
        ),
      )
      .orderBy(asc(auditLog.createdAt)),
    db
      .select({
        subject: emailOutbox.subject,
        status: emailOutbox.status,
        createdAt: emailOutbox.createdAt,
        sentAt: emailOutbox.sentAt,
      })
      .from(emailOutbox)
      .where(sql`lower(${emailOutbox.to}) = ${email}`)
      .orderBy(asc(emailOutbox.createdAt)),
  ])

  await writeAudit(db, { actorId: actor.id, action: 'user.exported', targetType: 'user', targetId: userId })

  return {
    exportedAt: new Date().toISOString(),
    hinweis:
      'Datenauskunft nach Art. 15 DSGVO. Passwörter werden nur als Hash gespeichert und sind nicht enthalten; Rate-Limit-Zähler enthalten nur Hashes.',
    account: user,
    sessions: activeSessions,
    oidcAccounts: linkedAccounts,
    requests: ownRequests,
    comments,
    requestEvents: events,
    files,
    auditLog: audit,
    emails: mails,
  }
}
