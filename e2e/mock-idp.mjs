// Minimaler OpenID-Connect-Anbieter für die E2E-Tests der Kunden-Anmeldung (Issue #60), ersetzt den TUM-Keycloak.
// Die Anmeldeseite fragt nur nach der E-Mail-Adresse und meldet sie als bestätigt zurück.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const port = Number(process.env.MOCK_IDP_PORT ?? 3199)
const issuer = `http://localhost:${port}`
const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' }
const codes = new Map()

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const escape = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function readForm(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return new URLSearchParams(body)
}

createServer(async (req, res) => {
  const url = new URL(req.url, issuer)
  if (url.pathname === '/.well-known/openid-configuration') {
    return json(res, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    })
  }
  if (url.pathname === '/jwks') return json(res, { keys: [jwk] })
  if (url.pathname === '/authorize' && req.method === 'GET') {
    const hidden = [...url.searchParams]
      .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
      .join('')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`<!doctype html><html lang="de"><title>Test-Keycloak</title><main><h1>Test-Keycloak</h1>
      <form method="post" action="/authorize">${hidden}<label>E-Mail <input name="email" type="email"></label>
      <button>Weiter</button></form></main></html>`)
  }
  if (url.pathname === '/authorize' && req.method === 'POST') {
    const form = await readForm(req)
    const code = randomBytes(16).toString('hex')
    codes.set(code, {
      email: form.get('email'),
      nonce: form.get('nonce'),
      clientId: form.get('client_id'),
      challenge: form.get('code_challenge'),
    })
    const back = new URL(form.get('redirect_uri'))
    back.searchParams.set('code', code)
    back.searchParams.set('state', form.get('state') ?? '')
    back.searchParams.set('iss', issuer)
    res.writeHead(302, { Location: back.href })
    return res.end()
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = await readForm(req)
    const grant = codes.get(form.get('code'))
    codes.delete(form.get('code'))
    const verifier = form.get('code_verifier') ?? ''
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (!grant || challenge !== grant.challenge) return json(res, { error: 'invalid_grant' }, 400)
    const local = grant.email.split('@')[0]
    const idToken = await new SignJWT({
      nonce: grant.nonce,
      email: grant.email,
      email_verified: true,
      given_name: 'Test',
      family_name: local,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
      .setIssuer(issuer)
      .setAudience(grant.clientId)
      .setSubject(createHash('sha256').update(grant.email).digest('hex'))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    return json(res, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken })
  }
  if (url.pathname === '/health') return json(res, { ok: true })
  json(res, { error: 'not_found' }, 404)
}).listen(port)
