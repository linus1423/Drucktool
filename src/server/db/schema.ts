import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { INTERNAL_STATUSES, REQUEST_STATUSES } from '../../lib/status'
import { USER_ROLES, USER_STATUSES } from '../../lib/roles'
import type { JsonObject } from '../../lib/json'
import type { BillingAddress, DeliveryAddress } from '../../lib/address'
import { DELIVERY_METHODS } from '../../lib/order'
import type { OrderSnapshot } from '../../lib/snapshot'
import type { ChangeProposal } from '../../lib/proposal'

export const userRole = pgEnum('user_role', USER_ROLES)
export const userStatus = pgEnum('user_status', USER_STATUSES)
export const organisationStatus = pgEnum('organisation_status', ['pending', 'active', 'disabled'])
export const requestStatus = pgEnum('request_status', REQUEST_STATUSES)
export const internalStatus = pgEnum('internal_status', INTERNAL_STATUSES)
export const deliveryMethod = pgEnum('delivery_method', DELIVERY_METHODS)

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  street: text('street'),
  zip: text('zip'),
  city: text('city'),
  country: text('country').notNull().default('DE'),
  vatId: text('vat_id'),
  status: organisationStatus('status').notNull().default('pending'),
  ...timestamps,
})

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    role: userRole('role').notNull().default('customer'),
    status: userStatus('status').notNull().default('pending'),
    organisationId: uuid('organisation_id').references(() => organisations.id, {
      onDelete: 'set null',
    }),
    reviewedById: uuid('reviewed_by_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    emailNotifications: boolean('email_notifications').notNull().default(true),
    billingAddress: jsonb('billing_address').$type<BillingAddress>(),
    deliveryAddress: jsonb('delivery_address').$type<DeliveryAddress>(),
    // Gesetzt, wenn das Konto anonymisiert wurde (DSGVO, Issue #26). Aufträge bleiben erhalten.
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
    index('users_organisation_idx').on(t.organisationId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    // SHA-256 des Cookie-Tokens; das Token selbst wird nie gespeichert.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/** Einmal-Links für die Anmeldung per E-Mail. Gespeichert wird nur der SHA-256 des Tokens. */
export const loginTokens = pgTable(
  'login_tokens',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    redirect: text('redirect'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_tokens_email_idx').on(t.email)],
)

/**
 * Zähler für Rate-Limits und Kontosperren. Liegt in PostgreSQL, damit Limits Neustarts
 * überstehen und für alle App-Instanzen gelten. Der Schlüssel enthält nur einen Hash
 * von IP-Adresse bzw. E-Mail-Adresse. Abgelaufene Einträge räumt der Worker auf.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    hits: integer('hits').notNull().default(0),
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  },
  (t) => [index('rate_limits_window_idx').on(t.windowEndsAt)],
)

/** Verknüpfung eines Benutzers mit einem Konto beim OpenID-Connect-Anbieter. */
export const oidcAccounts = pgTable(
  'oidc_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oidc_accounts_issuer_subject_unique').on(t.issuer, t.subject), index('oidc_accounts_user_idx').on(t.userId)],
)

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number').generatedAlwaysAsIdentity({ startWith: 1001 }).notNull().unique(),
    // Organisationen sind optional; sichtbar ist ein Auftrag für seinen Ersteller.
    organisationId: uuid('organisation_id').references(() => organisations.id, { onDelete: 'restrict' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    // Nachbestellung: der Auftrag, der als Vorlage diente (Issue #10).
    reorderOfId: uuid('reorder_of_id').references((): AnyPgColumn => requests.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    quantity: integer('quantity'),
    desiredDate: date('desired_date'),
    // Veraltet: freie Optionen aus der Zeit vor dem Wizard.
    options: jsonb('options').$type<JsonObject>().notNull().default({}),
    // Auswahl aus dem Wizard samt Preis und den dabei geltenden Katalogwerten (Lastenheft 6:
    // spätere Preisänderungen wirken nicht auf abgeschickte Aufträge). Null bei Altaufträgen.
    order: jsonb('order').$type<OrderSnapshot>(),
    totalCents: integer('total_cents'),
    // Kopie der Rechnungsadresse beim Absenden; spätere Profiländerungen wirken nicht zurück.
    billingAddress: jsonb('billing_address').$type<BillingAddress>(),
    deliveryMethod: deliveryMethod('delivery_method').notNull().default('pickup'),
    deliveryAddress: jsonb('delivery_address').$type<DeliveryAddress>(),
    // Zustimmung zu den Auftragsbedingungen beim verbindlichen Absenden (Lastenheft Schritt 8).
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
    termsVersion: text('terms_version'),
    // Offener Änderungsvorschlag der Druckerei, wartet auf die Zustimmung des Kunden (Issue #50).
    proposal: jsonb('proposal').$type<ChangeProposal>(),
    status: requestStatus('status').notNull().default('submitted'),
    // Seit wann der Auftrag im aktuellen Status steht (für „wartet lange“, Issue #14).
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    // Von der Druckerei zugesagter Termin, für Kunden sichtbar.
    promisedDate: date('promised_date'),
    // Interne Frist, nur für Mitarbeiter.
    internalDueDate: date('internal_due_date'),
    // Nur für Mitarbeiter sichtbar, solange der Auftrag bestätigt ist.
    internalStatus: internalStatus('internal_status'),
    // Die Druckerei nimmt einen Auftrag immer durch einen Mitarbeiter an.
    confirmedById: uuid('confirmed_by_id').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    // Optimistic Locking: jede Änderung erhöht die Version, Updates prüfen die erwartete Version.
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('requests_organisation_idx').on(t.organisationId),
    index('requests_created_by_idx').on(t.createdById),
    index('requests_status_idx').on(t.status),
    index('requests_assignee_idx').on(t.assigneeId),
  ],
)

export const requestComments = pgTable(
  'request_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    // Interne Notizen sind nur für Mitarbeiter sichtbar.
    internal: boolean('internal').notNull().default(false),
    // Per @Name erwähnte Mitarbeiter (Issue #13).
    mentionedIds: uuid('mentioned_ids').array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('request_comments_request_idx').on(t.requestId)],
)

/**
 * Beobachter eines Auftrags (Issue #13). Ersteller und Zuständiger beobachten automatisch;
 * eine Zeile mit muted = true schaltet das für diesen Benutzer ab.
 */
export const requestWatchers = pgTable(
  'request_watchers',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    muted: boolean('muted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] }), index('request_watchers_user_idx').on(t.userId)],
)

export const requestEventType = pgEnum('request_event_type', [
  'created',
  'updated',
  'status_changed',
  'internal_status_changed',
  'assigned',
  'commented',
  'change_proposed',
  'change_accepted',
  'change_rejected',
  'change_withdrawn',
  'dates_changed',
])

export const requestEvents = pgTable(
  'request_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    type: requestEventType('type').notNull(),
    fromStatus: requestStatus('from_status'),
    toStatus: requestStatus('to_status'),
    data: jsonb('data').$type<JsonObject>().notNull().default({}),
    internal: boolean('internal').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('request_events_request_idx').on(t.requestId)],
)

export const fileRole = pgEnum('file_role', ['main', 'cover', 'attachment'])
export const pdfStatus = pgEnum('pdf_status', ['ok', 'encrypted', 'unreadable', 'not_pdf'])

/**
 * Hochgeladene Druckdaten. Dateien werden vor dem Absenden hochgeladen und hängen
 * bis dahin nur am Besitzer; beim Absenden werden sie dem Auftrag zugeordnet.
 */
export const requestFiles = pgTable(
  'request_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'cascade' }),
    // Anhang an einer Nachricht (Issue #8); interne Notizen vererben ihre Sichtbarkeit.
    commentId: uuid('comment_id').references(() => requestComments.id, { onDelete: 'cascade' }),
    role: fileRole('role').notNull(),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mimeType: text('mime_type').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    // Ergebnis der PDF-Prüfung. Auch unlesbare Dateien werden angenommen (Lastenheft 8).
    pdfStatus: pdfStatus('pdf_status').notNull(),
    pageCount: integer('page_count'),
    pageWidthMm: integer('page_width_mm'),
    pageHeightMm: integer('page_height_mm'),
    mixedPageSizes: boolean('mixed_page_sizes').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_files_request_idx').on(t.requestId),
    index('request_files_owner_idx').on(t.ownerId),
    index('request_files_comment_idx').on(t.commentId),
  ],
)

export const emailStatus = pgEnum('email_status', ['pending', 'sent', 'failed'])

/**
 * Ausgehende E-Mails. Sie werden in derselben Transaktion wie die auslösende
 * Änderung geschrieben und von einem Worker verschickt (Transactional Outbox).
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    html: text('html').notNull(),
    status: emailStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('email_outbox_pending_idx').on(t.status, t.nextAttemptAt)],
)

export type User = typeof users.$inferSelect
export type Organisation = typeof organisations.$inferSelect
export type Request = typeof requests.$inferSelect

// ---------------------------------------------------------------------------
// Katalog und Preise (Lastenheft Abschnitt 3.2 und 6). Admins pflegen alles im Tool.
// ---------------------------------------------------------------------------

export const formatKind = pgEnum('format_kind', ['print', 'plot', 'custom'])

/** Endformate. "plot" wird auf dem Plotter gedruckt (A0 bis A2). */
export const formats = pgTable('formats', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  kind: formatKind('kind').notNull().default('print'),
  widthMm: integer('width_mm'),
  heightMm: integer('height_mm'),
  allowsDuplex: boolean('allows_duplex').notNull().default(true),
  available: boolean('available').notNull().default(true),
  helpText: text('help_text').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
})

export const bindingPriceUnit = pgEnum('binding_price_unit', ['copy', 'sheet'])

export const bindings = pgTable('bindings', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  /** Preis pro Exemplar (oder pro Blatt, z. B. beim Laminieren). */
  priceCents: integer('price_cents').notNull().default(0),
  priceUnit: bindingPriceUnit('price_unit').notNull().default('copy'),
  /** Einmalkosten pro Auftrag, z. B. 7 € bei Leimbindung. */
  setupFeeCents: integer('setup_fee_cents').notNull().default(0),
  allowsDuplex: boolean('allows_duplex').notNull().default(true),
  /** Separates Deckblatt mit Coverfarbe möglich. */
  allowsCover: boolean('allows_cover').notNull().default(false),
  /** Vorne und hinten unterschiedliche Coverfarben, durchsichtiges Cover möglich. */
  allowsSplitCover: boolean('allows_split_cover').notNull().default(false),
  /** Das Ergebnis wird zugeschnitten (z. B. Leimbindung), randlos geht dann immer. */
  trimmed: boolean('trimmed').notNull().default(false),
  available: boolean('available').notNull().default(true),
  helpText: text('help_text').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
})

/** Zulässige Kombinationen aus Endformat und Bindung. */
export const formatBindings = pgTable(
  'format_bindings',
  {
    formatId: text('format_id')
      .notNull()
      .references(() => formats.id, { onDelete: 'cascade' }),
    bindingId: text('binding_id')
      .notNull()
      .references(() => bindings.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('format_bindings_unique').on(t.formatId, t.bindingId)],
)

export const papers = pgTable('papers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  grammage: integer('grammage').notNull(),
  /** Preis pro Bogen auf dem normalen Drucker. */
  priceA3Cents: integer('price_a3_cents'),
  priceSra3Cents: integer('price_sra3_cents'),
  /** Preise pro Plot (Plotterpapier). */
  priceA0Cents: integer('price_a0_cents'),
  priceA1Cents: integer('price_a1_cents'),
  priceA2Cents: integer('price_a2_cents'),
  forCover: boolean('for_cover').notNull().default(false),
  forInner: boolean('for_inner').notNull().default(true),
  forPlotter: boolean('for_plotter').notNull().default(false),
  /** Größtes Endformat, das auf diesem Papier möglich ist. */
  maxFormatId: text('max_format_id').references(() => formats.id, { onDelete: 'set null' }),
  available: boolean('available').notNull().default(true),
  helpText: text('help_text').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
})

export const coverColors = pgTable('cover_colors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  hex: text('hex'),
  transparent: boolean('transparent').notNull().default(false),
  available: boolean('available').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
})

/** Coverfarben, die es auf einem Deckblattpapier gibt (z. B. 250 g/m² nur Weiß). */
export const paperCoverColors = pgTable(
  'paper_cover_colors',
  {
    paperId: uuid('paper_id')
      .notNull()
      .references(() => papers.id, { onDelete: 'cascade' }),
    coverColorId: uuid('cover_color_id')
      .notNull()
      .references(() => coverColors.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('paper_cover_colors_unique').on(t.paperId, t.coverColorId)],
)

/** Übrige Preise und Texte als Schlüssel/Wert, z. B. Druckpreise pro Image und Mindestpreis. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Protokoll aller Änderungen an Katalog und Preisen (wer, wann, vorher/nachher). */
export const catalogChanges = pgTable(
  'catalog_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before').$type<JsonObject | null>(),
    after: jsonb('after').$type<JsonObject | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('catalog_changes_created_idx').on(t.createdAt)],
)

/**
 * Protokoll der Admin-Aktionen und Anmeldungen (Issue #25). Wird in derselben Transaktion
 * wie die Änderung geschrieben. Enthält nie Passwörter oder Hashes; Namen werden beim
 * Anzeigen über die IDs nachgeschlagen.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    organisationId: uuid('organisation_id').references(() => organisations.id, { onDelete: 'set null' }),
    before: jsonb('before').$type<JsonObject | null>(),
    after: jsonb('after').$type<JsonObject | null>(),
    data: jsonb('data').$type<JsonObject>().notNull().default({}),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_actor_idx').on(t.actorId),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_organisation_idx').on(t.organisationId),
  ],
)

export type Format = typeof formats.$inferSelect
export type Binding = typeof bindings.$inferSelect
export type Paper = typeof papers.$inferSelect
export type CoverColor = typeof coverColors.$inferSelect
export type RequestFile = typeof requestFiles.$inferSelect
