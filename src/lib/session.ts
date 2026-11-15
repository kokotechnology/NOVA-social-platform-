const ACCESS_TOKEN_STORAGE_KEY = 'novakoko.auth.access-token'
export const AUTH_SESSION_EXPIRED_EVENT = 'nova:auth-session-expired'

function getTokenExpiration(token: string) {
  const [, encodedPayload, signature] = token.split('.')
  if (!encodedPayload || !signature) return null

  try {
    const base64Payload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(base64Payload.padEnd(Math.ceil(base64Payload.length / 4) * 4, '='))) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

export function storeAccessToken(token: string) {
  const expiresAt = getTokenExpiration(token)
  if (expiresAt === null || expiresAt <= Date.now()) {
    throw new Error('The API returned an invalid or expired authentication session.')
  }

  localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token)
}

export function getStoredAccessToken() {
  const token = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)
  if (!token) return null

  const expiresAt = getTokenExpiration(token)
  if (expiresAt === null || expiresAt <= Date.now()) {
    expireStoredAccessToken(token)
    return null
  }

  return token
}

export function clearStoredAccessToken() {
  localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
}

export function expireStoredAccessToken(expectedToken?: string | null) {
  if (!expectedToken || localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) !== expectedToken) return

  clearStoredAccessToken()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT))
  }
}
