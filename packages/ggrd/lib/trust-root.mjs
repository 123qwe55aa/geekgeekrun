// This module is deliberately limited to public release metadata. Signing keys
// belong to the offline release process and must never be distributed to clients.
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAG44re9BTgJpfdqdPHhuDKTKzUNsVGcFWJwsIqN29eT0=
-----END PUBLIC KEY-----`

export const CHANNEL_MANIFEST_ENDPOINTS = Object.freeze({
  stable: 'https://github.com/123qwe55aa/geekgeekrun/releases/download/ggrd-stable/manifest.json',
  beta: 'https://github.com/123qwe55aa/geekgeekrun/releases/download/ggrd-beta/manifest.json'
})

export function createTrustRoot({ publicKey = RELEASE_PUBLIC_KEY, manifestEndpoints = CHANNEL_MANIFEST_ENDPOINTS } = {}) {
  for (const endpoint of Object.values(manifestEndpoints)) {
    if (new URL(endpoint).protocol !== 'https:') throw new TypeError('Manifest endpoints must use HTTPS')
  }
  return Object.freeze({ publicKey, manifestEndpoints: Object.freeze({ ...manifestEndpoints }) })
}
