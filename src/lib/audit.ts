// Bezeichnungen für das Audit-Log (Server und Oberfläche).

export const AUDIT_ACTIONS = [
  'login.succeeded',
  'login.failed',
  'registration.approved',
  'registration.rejected',
  'user.created',
  'user.updated',
  'organisation.created',
  'organisation.updated',
  'organisation_request.approved',
  'organisation_request.rejected',
  'user.anonymized',
  'user.exported',
  'mail_template.updated',
  'mail_template.reset',
  'mail_layout.updated',
  'file.virus_found',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'login.succeeded': 'Anmeldung',
  'login.failed': 'Anmeldung fehlgeschlagen',
  'registration.approved': 'Registrierung freigegeben',
  'registration.rejected': 'Registrierung abgelehnt',
  'user.created': 'Benutzer angelegt',
  'user.updated': 'Benutzer geändert',
  'organisation.created': 'Organisation angelegt',
  'organisation.updated': 'Organisation geändert',
  'organisation_request.approved': 'Organisationsanfrage angenommen',
  'organisation_request.rejected': 'Organisationsanfrage abgelehnt',
  'user.anonymized': 'Benutzer anonymisiert',
  'user.exported': 'Datenauskunft erstellt',
  'mail_template.updated': 'E-Mail-Vorlage geändert',
  'mail_template.reset': 'E-Mail-Vorlage zurückgesetzt',
  'mail_layout.updated': 'E-Mail-Layout geändert',
  'file.virus_found': 'Schadsoftware in Upload gefunden',
}

export const LOGIN_METHOD_LABELS: Record<string, string> = {
  password: 'Passwort',
  link: 'Anmeldelink',
  oidc: 'Single Sign-on',
}

export const LOGIN_FAILURE_LABELS: Record<string, string> = {
  wrong_credentials: 'falsches Passwort oder unbekannte Adresse',
  blocked: 'Konto vorübergehend gesperrt',
  pending: 'noch nicht freigegeben',
  inactive: 'Konto nicht aktiv',
  organisation_inactive: 'Organisation nicht aktiv',
  sso_required: 'nur über Single Sign-on erlaubt',
  invalid_link: 'Link ungültig oder abgelaufen',
  denied: 'vom Anmeldedienst abgelehnt',
}

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  firstName: 'Vorname',
  lastName: 'Nachname',
  email: 'E-Mail',
  role: 'Rolle',
  status: 'Status',
  organisationId: 'Organisation',
  organisationIds: 'Organisationen',
  phone: 'Telefon',
  street: 'Straße',
  zip: 'PLZ',
  city: 'Ort',
  country: 'Land',
  vatId: 'USt-IdNr.',
}
