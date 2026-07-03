import { PlayRecord } from './leaderboard'

// ─── Player profile (name / avatar) — localStorage ────────────────────────────

export interface PlayerProfile {
  name: string
  avatar: string
}

const PROFILE_KEY = 'bentoBlitz_profile'
const DEFAULT_NAME = '阿鬥'

// Placeholder avatars until real art exists — picked once per player and kept stable.
const AVATAR_POOL = ['🧑', '🐱', '🐶', '🦊', '🐼', '🐵', '🐸', '🦄', '🐯', '🐨']

export const loadProfile = (): PlayerProfile => {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (p && typeof p.name === 'string' && typeof p.avatar === 'string') return p
    }
  } catch { /* fall through to fresh profile */ }
  const fresh: PlayerProfile = { name: DEFAULT_NAME, avatar: AVATAR_POOL[Math.floor(Math.random() * AVATAR_POOL.length)] }
  saveProfile(fresh)
  return fresh
}

export const saveProfile = (p: PlayerProfile): void => {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)) } catch {}
}

// ─── Player level / XP ─────────────────────────────────────────────────────
// XP comes from *every* play, not just the score. A flat "finished a round"
// bonus plus a cut of the score — so level reflects both how good someone is
// AND how much they've actually played, the way most mobile games do it
// (otherwise a single lucky high score would matter more than months of play).
const XP_PER_PLAY = 15          // flat XP for finishing a round, regardless of score
const XP_PER_SCORE_POINT = 0.4  // extra XP per positive score point (negative scores add 0, never subtract)
const XP_LEVEL_BASE = 50        // curve constant used by levelForXp() / xpForLevelStart() below

export const totalXpFromHistory = (history: PlayRecord[]): number =>
  history.reduce((sum, r) => sum + XP_PER_PLAY + Math.max(0, r.score) * XP_PER_SCORE_POINT, 0)

// Square-root XP curve (the classic old-school-RPG leveling shape): reaching level N
// takes (N-1)^2 * XP_LEVEL_BASE total XP. Since that grows quadratically, each new
// level costs progressively more XP than the last — fast early levels, a real grind
// later on — without needing a lookup table.
export const levelForXp = (xp: number): number => Math.floor(Math.sqrt(xp / XP_LEVEL_BASE)) + 1

// Inverse of levelForXp — total XP required to have *just reached* `level`.
export const xpForLevelStart = (level: number): number => (level - 1) ** 2 * XP_LEVEL_BASE

export interface LevelInfo {
  level: number
  xp: number
  xpIntoLevel: number // progress within the current level
  xpForNext: number   // XP span of the current level (denominator for the progress bar)
  progress: number    // 0..1
}

export const getLevelInfo = (history: PlayRecord[]): LevelInfo => {
  const xp = totalXpFromHistory(history)
  const level = levelForXp(xp)
  const xpStart = xpForLevelStart(level)
  const xpNext = xpForLevelStart(level + 1)
  const xpIntoLevel = xp - xpStart
  const xpForNext = xpNext - xpStart
  const progress = xpForNext > 0 ? Math.min(1, xpIntoLevel / xpForNext) : 0
  return { level, xp: Math.round(xp), xpIntoLevel: Math.round(xpIntoLevel), xpForNext: Math.round(xpForNext), progress }
}
