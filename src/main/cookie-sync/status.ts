/** Tracks the Chrome extension's last heartbeat so the renderer can show
 *  appropriate guidance (install prompt vs "log in browser to auto-sync").
 *  State is kept in memory and persisted to settings so it survives
 *  app restarts. */

import { getSetting, setSetting } from '../database/queries/settings'

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours
const SETTING_KEY = 'cookie-sync.extensionLastSeen'

let extensionLastSeen: number | null = null
let serverRunning = false

/** Load persisted last-seen timestamp from settings (called once at startup). */
export function loadExtensionStatus(): void {
  try {
    const raw = getSetting(SETTING_KEY)
    if (raw) {
      const ts = Number(raw)
      if (!Number.isNaN(ts) && ts > 0) {
        extensionLastSeen = ts
      }
    }
  } catch {
    // settings table may not be ready yet; ignore
  }
}

export function markExtensionHeartbeat(): void {
  extensionLastSeen = Date.now()
  try {
    setSetting(SETTING_KEY, String(extensionLastSeen))
  } catch {
    // persistence is best-effort
  }
}

export function setServerRunning(running: boolean): void {
  serverRunning = running
}

export type ExtensionStatusState = 'unknown' | 'active' | 'stale'

export interface ExtensionStatus {
  status: ExtensionStatusState
  lastSeen: number | null
  serverRunning: boolean
}

export function getExtensionStatus(): ExtensionStatus {
  let status: ExtensionStatusState = 'unknown'
  if (extensionLastSeen !== null) {
    status = Date.now() - extensionLastSeen <= STALE_THRESHOLD_MS ? 'active' : 'stale'
  }
  return { status, lastSeen: extensionLastSeen, serverRunning }
}
