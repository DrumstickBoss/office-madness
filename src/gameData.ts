// ─── Shared game data & utilities ────────────────────────────────────────────

export interface LevelDef {
  id: number; name: string; icon: string
  desc: string; unlocked: boolean; accent: string; bg: string
}

export const LEVELS: LevelDef[] = [
  { id: 1, name: '社畜接便當', icon: '🍱', desc: '接便當、躲陷阱、正確處理來電！',
    unlocked: true,  accent: '#4ade80', bg: 'linear-gradient(135deg,#1a4a1a,#2d6b2d)' },
  { id: 2, name: '垃圾分類王', icon: '♻️',  desc: '滑動丟出垃圾，考驗你的彈道與反應力！',
    unlocked: true,  accent: '#60a5fa', bg: 'linear-gradient(135deg,#1a2a4a,#2a5298)' },
  { id: 3, name: '網銀運動會', icon: '🏃',  desc: '跑酷闖關！跳躍、下滑、借到籤條上的道具！',
    unlocked: true,  accent: '#c084fc', bg: 'linear-gradient(135deg,#2a1a4a,#5a2a98)' },
  { id: 4, name: '加班修羅場', icon: '💼',  desc: '即將推出...',
    unlocked: false, accent: '#f97316', bg: 'linear-gradient(135deg,#4a1a0a,#8b4010)' },
]

// ─── Star rating (1–3 ★ per level, like most casual/mobile games) ────────────
// The standard pattern (Angry Birds, Candy Crush, etc.) is three tiers against
// a per-level "par" score, since raw score isn't comparable across games with
// different point scales:
//   ★☆☆ = cleared it — reached a modest score, i.e. didn't just survive
//   ★★☆ = solid play — comfortably past average
//   ★★★ = mastery — near-optimal play for that level's scoring system
// Thresholds below are calibrated from each level's own scoring constants
// (not a single global cutoff, since e.g. Level 2's "+100 per correct throw"
// scale is ~4x Level 1's "+25 per catch" scale).
const STAR_THRESHOLDS: Record<number, [oneStar: number, twoStar: number, threeStar: number]> = {
  // Level 1 社畜接便當: +25/catch (+35 boosted), +20/call, 60s round —
  // a few good catches clears 1★, a solid run gets 2★, near-perfect play gets 3★.
  1: [50, 150, 300],
  // Level 2 垃圾分類王: +100/correct throw, +50/bonus slice — same shape as
  // Level 1's curve, scaled up ~4x to match this level's larger point values.
  2: [300, 800, 1500],
  // Level 3 網銀運動會: +8/s run (360 pts at 45s) + dodge bonuses + up to +500 bonus time.
  // 1★ = survived most of the run; 2★ = good dodging + partial bonus; 3★ = full bonus collected.
  3: [250, 500, 800],
}
// Levels without a tuned curve yet (3, 4) fall back to this generic shape.
const DEFAULT_STAR_THRESHOLDS: [number, number, number] = [100, 300, 600]

export const getStars = (levelId: number, score: number): number => {
  const [one, two, three] = STAR_THRESHOLDS[levelId] ?? DEFAULT_STAR_THRESHOLDS
  if (score >= three) return 3
  if (score >= two) return 2
  if (score >= one) return 1
  return 0
}

