import { describe, expect, it } from 'vitest'
import {
  nameSimilarity,
  organisationMatchScore,
  STRONG_MATCH_THRESHOLD,
  SUGGESTION_THRESHOLD,
  suggestOrganisations,
} from '~/lib/organisation-match'

describe('Vorschlag der naheliegendsten Organisation (Issue #176)', () => {
  it('erkennt gleiche Namen trotz Schreibweise, Umlauten und Rechtsform', () => {
    expect(nameSimilarity('Lehrstuhl für Drucktechnik', 'lehrstuhl fuer drucktechnik')).toBe(1)
    expect(nameSimilarity('Muster GmbH', 'Muster')).toBe(1)
    expect(nameSimilarity('Fachschaft Maschinenbau', 'Fachschaft Maschienbau')).toBeGreaterThanOrEqual(STRONG_MATCH_THRESHOLD)
  })

  it('erkennt Abkürzungen und Teilnamen', () => {
    expect(nameSimilarity('FSMB', 'Fachschaft Maschinenbau')).toBeGreaterThanOrEqual(STRONG_MATCH_THRESHOLD)
    expect(nameSimilarity('Fachschaft Maschinenbau', 'Fachschaft Maschinenbau TUM')).toBeGreaterThanOrEqual(
      STRONG_MATCH_THRESHOLD,
    )
  })

  it('hält verschiedene Organisationen auseinander', () => {
    expect(nameSimilarity('Fachschaft Mathematik', 'Fachschaft Physik')).toBeLessThan(STRONG_MATCH_THRESHOLD)
    expect(nameSimilarity('Lehrstuhl für Drucktechnik', 'Bäckerei Huber')).toBeLessThan(SUGGESTION_THRESHOLD)
  })

  it('wertet gleiche Stammdaten auf', () => {
    expect(organisationMatchScore({ name: 'Irgendwas', vatId: 'DE 123 456 789' }, { name: 'Anders', vatId: 'DE123456789' })).toBe(
      1,
    )
    const base = organisationMatchScore({ name: 'Institut A' }, { name: 'Institut B' })
    expect(
      organisationMatchScore({ name: 'Institut A', costCenter: '4711' }, { name: 'Institut B', costCenter: '4711' }),
    ).toBeGreaterThan(base)
    // Freemailer sagen nichts über die Organisation.
    expect(
      organisationMatchScore({ name: 'Institut A', email: 'a@gmail.com' }, { name: 'Institut B', email: 'b@gmail.com' }),
    ).toBe(base)
    expect(
      organisationMatchScore({ name: 'Institut A', email: 'a@tum.de' }, { name: 'Institut B', email: 'b@tum.de' }),
    ).toBeGreaterThan(base)
  })

  it('sortiert Vorschläge nach Übereinstimmung', () => {
    const suggestions = suggestOrganisations({ name: 'Fachschaft Maschinenbau' }, [
      { id: '1', name: 'Fachschaft Physik' },
      { id: '2', name: 'Fachschaft Maschinenbau e.V.' },
      { id: '3', name: 'Bäckerei Huber' },
    ])
    expect(suggestions[0]).toMatchObject({ id: '2', score: 1 })
    expect(suggestions.map((s) => s.id)).not.toContain('3')
  })
})
