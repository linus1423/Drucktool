// Testdaten für die E2E-Tests per Skript statt über die Oberfläche (Issue #35). Nutzt dieselben Server-Funktionen
// wie die Integrationstests, damit Aufträge genau so entstehen wie über den Wizard.
import { hashPassword } from '../src/server/auth/password.server'
import { placeOrder } from '../tests/order-fixture'
import { db } from './helpers'

process.env.DATABASE_URL ??= 'postgres://drucktool:drucktool@localhost:5432/drucktool'

/** Mitarbeiter mit Passwort, damit sich zwei Mitarbeiter gleichzeitig anmelden können. */
export async function createStaff(tag: string) {
  const email = `e2e-${tag}-${Date.now()}@example.com`
  const password = `e2e-passwort-${Date.now()}`
  await db`insert into users (email, first_name, last_name, role, status, password_hash)
    values (${email}, 'Max', 'Mitarbeiter', 'staff', 'active', ${await hashPassword(password)})`
  return { email, password }
}

/** Auftrag eines Kunden im Status „Eingereicht“; liefert den Pfad der Detailseite. */
export async function seedOrder(customerEmail: string, title: string) {
  const [user] = await db<{ id: string }[]>`select id from users where email = ${customerEmail}`
  const created = await placeOrder({ id: user!.id, role: 'customer' }, { title })
  return `/auftraege/${created.id}`
}
