// ─── Shared play-history / leaderboard storage (localStorage) ────────────────

export interface PlayRecord {
  levelId: number
  score: number
  ts: number
}

const LS_KEY = 'bentoBlitz_history'
const MAX_RECORDS = 300

export const loadHistory = (): PlayRecord[] => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

// Appends one play record and trims the log so storage doesn't grow unbounded.
export const addRecord = (levelId: number, score: number): PlayRecord[] => {
  const history = loadHistory()
  history.push({ levelId, score, ts: Date.now() })
  const trimmed = history.length > MAX_RECORDS ? history.slice(history.length - MAX_RECORDS) : history
  try { localStorage.setItem(LS_KEY, JSON.stringify(trimmed)) } catch {}
  return trimmed
}

export const getBestForLevel = (levelId: number, history?: PlayRecord[]): number =>
  (history ?? loadHistory())
    .filter(r => r.levelId === levelId)
    .reduce((max, r) => Math.max(max, r.score), 0)
