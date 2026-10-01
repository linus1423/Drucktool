// Verschickt E-Mails aus der Outbox und räumt abgelaufene Daten auf.
// Läuft als eigener Prozess (siehe docker-compose.yml).
import { getDb } from '../src/server/db/client.server'
import { createMailTransport } from '../src/server/mail/transport.server'
import { processOutbox } from '../src/server/mail/worker.server'
import { CLEANUP_INTERVAL_MS, runCleanup } from '../src/server/maintenance/cleanup.server'

const intervalMs = Number(process.env.MAIL_POLL_INTERVAL_MS ?? 5000)
const transport = createMailTransport()
const db = getDb()
let stopping = false

console.log(`[mail] Worker gestartet${transport.dryRun ? ' (Testmodus: SMTP_URL fehlt, Mails werden nur protokolliert)' : ''}`)

// Abgelaufene Sitzungen, Anmeldelinks und Rate-Limit-Zähler: beim Start und dann stündlich.
await runCleanup(db)
const cleanupTimer = setInterval(() => void runCleanup(db), CLEANUP_INTERVAL_MS)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    clearInterval(cleanupTimer)
  })
}

while (!stopping) {
  try {
    // Solange volle Batches kommen, direkt weitermachen.
    while (!stopping && (await processOutbox(db, transport)) > 0) {}
  } catch (error) {
    console.error('[mail] Fehler beim Verarbeiten der Outbox', error)
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}

await (db.$client as { end: () => Promise<void> }).end()
console.log('[mail] Worker beendet')
