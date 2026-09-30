import { sql } from 'drizzle-orm'
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { REQUEST_STATUSES } from '../../lib/status'
import { USER_ROLES, USER_STATUSES } from '../../lib/roles'
import type { JsonObject } from '../../lib/json'

export const userRole = pgEnum('user_role', USER_ROLES)
export const userStatus = pgEnum('user_status', USER_STATUSES)
export const organisationStatus = pgEnum('organisation_status', ['pending', 'active', 'disabled'])
export const requestStatus = pgEnum('request_status', REQUEST_STATUSES)

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

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: integer('number').generatedAlwaysAsIdentity({ startWith: 1001 }).notNull().unique(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    quantity: integer('quantity'),
    desiredDate: date('desired_date'),
    // Konfigurierbare Produktoptionen (Material, Bindung, ...), folgt mit dem Bestellformular.
    options: jsonb('options').$type<JsonObject>().notNull().default({}),
    quoteAmountCents: integer('quote_amount_cents'),
    quoteNote: text('quote_note'),
    status: requestStatus('status').notNull().default('new'),
    // Optimistic Locking: jede Änderung erhöht die Version, Updates prüfen die erwartete Version.
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    index('requests_organisation_idx').on(t.organisationId),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('request_comments_request_idx').on(t.requestId)],
)

export const requestEventType = pgEnum('request_event_type', [
  'created',
  'updated',
  'status_changed',
  'assigned',
  'commented',
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

export type User = typeof users.$inferSelect
export type Organisation = typeof organisations.$inferSelect
export type Request = typeof requests.$inferSelect
