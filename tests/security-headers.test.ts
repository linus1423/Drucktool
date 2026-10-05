import { afterEach, describe, expect, it } from 'vitest'
import { contentSecurityPolicy, createNonce, isHttps, securityHeaders, withSecurityHeaders } from '~/server/security-headers'

describe('Security-Header', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })

  it('erzeugt pro Aufruf einen neuen Nonce', () => {
    const a = createNonce()
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(createNonce()).not.toBe(a)
  })

  it('erlaubt Skripte nur vom eigenen Server oder mit Nonce', () => {
    const csp = contentSecurityPolicy('abc')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  it('setzt HSTS nur mit HTTPS und CSP nur auf Wunsch', () => {
    const plain = securityHeaders({ nonce: 'n', https: false, csp: false })
    expect(plain['Strict-Transport-Security']).toBeUndefined()
    expect(plain['Content-Security-Policy']).toBeUndefined()
    expect(plain).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    })
    const full = securityHeaders({ nonce: 'n', https: true, csp: true })
    expect(full['Strict-Transport-Security']).toContain('max-age=31536000')
    expect(full['Content-Security-Policy']).toContain("'nonce-n'")
  })

  it('erkennt HTTPS wie beim Secure-Cookie', () => {
    process.env.COOKIE_SECURE = 'false'
    expect(isHttps()).toBe(false)
    process.env.COOKIE_SECURE = 'true'
    expect(isHttps()).toBe(true)
    delete process.env.COOKIE_SECURE
    process.env.NODE_ENV = 'production'
    expect(isHttps()).toBe(true)
  })

  it('setzt Header auch auf Antworten mit unveränderlichen Headern', () => {
    const redirect = Response.redirect('http://localhost/ziel', 302)
    const result = withSecurityHeaders(redirect, { 'X-Content-Type-Options': 'nosniff' })
    expect(result.status).toBe(302)
    expect(result.headers.get('location')).toBe('http://localhost/ziel')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('lässt eine Route CSP und CORP selbst setzen, etwa für das Logo in E-Mails (Issue #188)', () => {
    const logo = new Response('x', {
      headers: { 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin' },
    })
    const result = withSecurityHeaders(logo, securityHeaders({ nonce: 'n', https: false, csp: true }))
    expect(result.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(result.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(result.headers.get('x-frame-options')).toBe('DENY')
    const page = withSecurityHeaders(new Response('x'), securityHeaders({ nonce: 'n', https: false, csp: true }))
    expect(page.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })
})
