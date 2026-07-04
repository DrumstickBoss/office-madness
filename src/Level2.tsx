import { useRef, useEffect, useState, useCallback } from 'react'
import { addRecord, getBestForLevel } from './leaderboard'

// ─── Canvas dimensions (mutable — updated on orientation change) ─────────────
const isPortraitViewport = () =>
  typeof window !== 'undefined' && window.innerWidth < window.innerHeight

let CW = isPortraitViewport() ? 390 : 720
let CH = isPortraitViewport() ? 700 : 480

// ─── Game tuning ───────────────────────────────────────────────────────────
const THROW_PHASE_MS = 45_000
const BONUS_PHASE_MS = 14_000
const TOTAL_MS = THROW_PHASE_MS + BONUS_PHASE_MS
const GRAVITY = 420 // px/s² — only applied to Bonus Time items; low enough that they arc up to mid-screen
const DRAG_K = 4.2 // swipe px → launch velocity px/s (throws travel in a straight line)
const MAX_LAUNCH_SPEED = 900
const MIN_DRAG_DIST = 45
const SCORE_CORRECT = 100
const SCORE_WRONG_BIN = -30
const SCORE_DECOY_PENALTY = -500
const SCORE_PUTDOWN_WRONG = -50
const SCORE_SLICE = 50
const BIN_W = 92
const BIN_H = 78
const BIN_RETARGET_MIN_MS = 2400
const BIN_RETARGET_MAX_MS = 4400
const BIN_REORDER_AT_MS = 15_000 // bins slide off-screen once and re-enter in a shuffled order
const BIN_SWING_AT_MS = 25_000 // bins switch to a continuous basketball-hoop-style sway
const BIN_TRANSITION_MS = 420
const BIN_SWING_AMP = 50
const BONUS_SPAWN_MIN_MS = 380
const BONUS_SPAWN_MAX_MS = 640
const BONUS_BANNER_MS = 2200
const BONUS_WARNING_MS = 5000 // flash a "here it comes" warning for the last 5s of the throw phase
const BONUS_INTRO_MS = 1300 // beat of "🚛 垃圾車來襲！" before bonus items start spawning — no more instant cut
const DECOY_HINT_MS = 6000 // how long the first-ever decoy's "don't throw me" tooltip stays up

// ─── Bin / item catalogue ───────────────────────────────────────────────────
type BinType = 'general' | 'recycle' | 'food'

interface BinVisual { type: BinType; label: string; icon: string; color: string; lid: string }
const BIN_DEFS: Record<BinType, BinVisual> = {
  recycle: { type: 'recycle', label: '資源回收', icon: '♻️', color: '#2f6fd6', lid: '#1c4fa8' },
  food: { type: 'food', label: '廚餘', icon: '🐟', color: '#2f9e52', lid: '#1c7a3a' },
  general: { type: 'general', label: '一般垃圾', icon: '🗑️', color: '#d6432f', lid: '#a82f1c' },
}
const BIN_TYPES: BinType[] = ['recycle', 'food', 'general']

interface TrashDef { category: BinType; icon: string; label: string }
const TRASH_ITEMS: TrashDef[] = [
  { category: 'recycle', icon: '🥤', label: '寶特瓶' },
  { category: 'recycle', icon: '📰', label: '舊報紙' },
  { category: 'recycle', icon: '🧴', label: '洗髮精罐' },
  { category: 'recycle', icon: '🧋', label: '手搖飲杯' },
  { category: 'food', icon: '🍌', label: '香蕉皮' },
  { category: 'food', icon: '🍎', label: '蘋果核' },
  { category: 'food', icon: '🍚', label: '剩飯' },
  { category: 'general', icon: '🧻', label: '衛生紙' },
  { category: 'general', icon: '🍬', label: '糖果包裝' },
  { category: 'general', icon: '🪥', label: '舊牙刷' },
]

interface DecoyDef { icon: string; label: string; penaltyMsg: string }
const DECOYS: DecoyDef[] = [
  { icon: '👴', label: '迷路的老人家', penaltyMsg: '老人家：我還沒問完路啊！！' },
  { icon: '😤', label: '查勤的女友', penaltyMsg: '啪！！女友：你居然想丟掉我？！' },
]
const DECOY_CHANCE = 0.18

// ─── Web Audio SFX (synthesized — no audio assets) ──────────────────────────
let audioCtx: AudioContext | null = null
const getAudioCtx = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audioCtx = new Ctor()
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    return audioCtx
  } catch { return null }
}

function playTone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0) {
  const ctx = getAudioCtx()
  if (!ctx) return
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(ctx.destination)
  const t0 = ctx.currentTime + delay
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

const playCorrect = () => { playTone(880, 0.1, 'square', 0.12); playTone(1320, 0.12, 'square', 0.1, 0.06) }
const playWrong = () => playTone(220, 0.22, 'sawtooth', 0.14)
const playSlice = () => playTone(1100, 0.06, 'triangle', 0.1)

function playSlap() {
  const ctx = getAudioCtx()
  if (!ctx) return
  const len = Math.floor(ctx.sampleRate * 0.12)
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const g = ctx.createGain()
  g.gain.value = 0.35
  src.connect(g)
  g.connect(ctx.destination)
  src.start()
}

function playScream() {
  const ctx = getAudioCtx()
  if (!ctx) return
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sawtooth'
  const t0 = ctx.currentTime
  osc.frequency.setValueAtTime(1200, t0)
  osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.4)
  g.gain.setValueAtTime(0.22, t0)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45)
  osc.connect(g)
  g.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + 0.5)
}

function playPenalty() {
  if (Math.random() < 0.5) playSlap(); else playScream()
  if (typeof navigator !== 'undefined' && navigator.vibrate) { try { navigator.vibrate([40, 30, 90]) } catch {} }
}

// Warning siren — two up/down sweeps, played once when the "垃圾車即將來襲" window opens
function playAlarmSweep() {
  const ctx = getAudioCtx()
  if (!ctx) return
  const t0 = ctx.currentTime
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sawtooth'
    const start = t0 + i * 0.5
    osc.frequency.setValueAtTime(500, start)
    osc.frequency.linearRampToValueAtTime(1000, start + 0.22)
    osc.frequency.linearRampToValueAtTime(500, start + 0.44)
    g.gain.setValueAtTime(0.001, start)
    g.gain.linearRampToValueAtTime(0.12, start + 0.05)
    g.gain.linearRampToValueAtTime(0.001, start + 0.44)
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.46)
  }
  if (typeof navigator !== 'undefined' && navigator.vibrate) { try { navigator.vibrate([80, 60, 80]) } catch {} }
}

const playCountdownBeep = () => playTone(900, 0.12, 'square', 0.15)

// Truck horn — honks once right as Bonus Time's intro card appears
function playTruckHonk() {
  playTone(220, 0.25, 'square', 0.16)
  playTone(180, 0.3, 'square', 0.14, 0.15)
}

// Für Elise opening phrase — looped as the Bonus Time BGM cue
const FUR_ELISE = [
  659.25, 622.25, 659.25, 622.25, 659.25, 493.88, 587.33, 523.25, 440.0,
  0, 261.63, 329.63, 440.0, 493.88,
  0, 329.63, 415.3, 493.88, 523.25,
]
let furEliseTimer: ReturnType<typeof setTimeout> | null = null
function startFurElise() {
  stopFurElise()
  let i = 0
  const step = () => {
    const freq = FUR_ELISE[i % FUR_ELISE.length]
    if (freq > 0) playTone(freq, 0.16, 'triangle', 0.08)
    i++
    furEliseTimer = setTimeout(step, 165)
  }
  step()
}
function stopFurElise() {
  if (furEliseTimer) { clearTimeout(furEliseTimer); furEliseTimer = null }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const rng = (min: number, max: number) => Math.random() * (max - min) + min
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const shuffle = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5)

// ─── Types ────────────────────────────────────────────────────────────────
interface FlyingItem {
  id: number
  kind: 'trash' | 'decoy'
  category?: BinType
  icon: string
  label: string
  x: number; y: number
  vx: number; vy: number
  rot: number; vrot: number
  bonus: boolean
}

interface Popup { id: number; x: number; y: number; text: string; color: string; born: number }

interface Bin {
  type: BinType; x: number; targetX: number; nextRetarget: number; laneCx: number
  flashUntil: number; flashGood: boolean
  outFromX: number // captured x when a push-out transition starts
  swingPhase: number; swingSpeed: number
}

interface QueueItem { kind: 'trash' | 'decoy'; category?: BinType; icon: string; label: string }

interface GameState {
  status: 'idle' | 'playing' | 'gameover'
  phase: 'throw' | 'bonus'
  score: number
  best: number
  lastFrameTs: number
  elapsed: number
  bins: Bin[]
  binTransition: 'idle' | 'out' | 'in'
  binTransitionStart: number
  binReorderTriggered: boolean
  flying: FlyingItem[]
  popups: Popup[]
  queueItem: QueueItem
  aiming: boolean
  aimStart: { x: number; y: number } | null
  aimCurrent: { x: number; y: number } | null
  sliceTrail: { x: number; y: number }[]
  shakeUntil: number
  flashUntil: number
  flashColor: string
  idCounter: number
  bonusAudioStarted: boolean
  truckX: number
  truckActive: boolean
  bonusSpawnAt: number
  bonusBannerUntil: number
  bonusIntroUntil: number
  lastPenaltyMsg: string | null
  // Onboarding feedback — teach by nudging during play instead of relying on the idle-screen wall of text
  hasThrownOnce: boolean
  decoyHintShownEver: boolean
  decoyHintActive: boolean
  decoyHintUntil: number
  warningPlayed: boolean
  warningBeepSecond: number
  hasSlicedOnce: boolean // Bonus Time — whether the player has dragged/sliced yet
}

function spawnTrashItem(): QueueItem {
  const t = pick(TRASH_ITEMS)
  return { kind: 'trash', category: t.category, icon: t.icon, label: t.label }
}

function spawnQueueItem(): QueueItem {
  if (Math.random() < DECOY_CHANCE) {
    const d = pick(DECOYS)
    return { kind: 'decoy', icon: d.icon, label: d.label }
  }
  return spawnTrashItem()
}

// Advances to the next queue item, arming a one-time "don't throw me" tooltip
// the first time a decoy ever shows up.
function nextQueueItem(gs: GameState, now: number) {
  gs.decoyHintActive = false
  const item = spawnQueueItem()
  gs.queueItem = item
  if (item.kind === 'decoy' && !gs.decoyHintShownEver) {
    gs.decoyHintShownEver = true
    gs.decoyHintActive = true
    gs.decoyHintUntil = now + DECOY_HINT_MS
  }
}

function makeBins(): Bin[] {
  const lanes = [CW * 0.18, CW * 0.5, CW * 0.82]
  const shuffled = [...BIN_TYPES].sort(() => Math.random() - 0.5)
  return shuffled.map((type, i) => ({
    type, x: lanes[i], targetX: lanes[i], laneCx: lanes[i],
    nextRetarget: performance.now() + rng(BIN_RETARGET_MIN_MS, BIN_RETARGET_MAX_MS),
    flashUntil: 0, flashGood: true,
    // Small, shared-speed phase offset — bins stay mostly in sync so they never swing into each other
    outFromX: lanes[i], swingPhase: i * 0.35, swingSpeed: 2.1,
  }))
}

function initState(best: number): GameState {
  return {
    status: 'idle', phase: 'throw', score: 0, best,
    lastFrameTs: 0, elapsed: 0,
    bins: makeBins(), binTransition: 'idle', binTransitionStart: 0, binReorderTriggered: false,
    flying: [], popups: [],
    // First item is always plain trash — a decoy as the very first thing the
    // player sees would need its "don't throw me" hint before they've thrown
    // anything at all, which crowded straight into the swipe-to-throw hint.
    queueItem: spawnTrashItem(),
    aiming: false, aimStart: null, aimCurrent: null, sliceTrail: [],
    shakeUntil: 0, flashUntil: 0, flashColor: '#ff3030',
    idCounter: 1, bonusAudioStarted: false,
    truckX: -160, truckActive: false, bonusSpawnAt: 0, bonusBannerUntil: 0, bonusIntroUntil: 0,
    lastPenaltyMsg: null,
    hasThrownOnce: false, hasSlicedOnce: false,
    decoyHintShownEver: false, decoyHintActive: false, decoyHintUntil: 0,
    warningPlayed: false, warningBeepSecond: 0,
  }
}

const THROWER_Y = () => CH - 90
const BIN_OPEN_Y = () => CH * 0.27

function addPopup(gs: GameState, x: number, y: number, text: string, color: string) {
  gs.popups.push({ id: gs.idCounter++, x, y, text, color, born: performance.now() })
}

// ─── Update ───────────────────────────────────────────────────────────────
function update(gs: GameState, now: number, dtMs: number) {
  const dt = dtMs / 1000
  gs.elapsed += dtMs

  // Warning window — the last few seconds before Bonus Time get louder instead of
  // cutting over instantly, so the switch doesn't blindside the player.
  if (gs.phase === 'throw') {
    const timeToBonus = THROW_PHASE_MS - gs.elapsed
    if (timeToBonus > 0 && timeToBonus <= BONUS_WARNING_MS) {
      if (!gs.warningPlayed) { gs.warningPlayed = true; playAlarmSweep() }
      const sec = Math.ceil(timeToBonus / 1000)
      if (sec <= 3 && sec !== gs.warningBeepSecond) { gs.warningBeepSecond = sec; playCountdownBeep() }
    }
  }

  // Phase transition → Bonus Time (with a brief title-card beat before items start spawning)
  if (gs.phase === 'throw' && gs.elapsed >= THROW_PHASE_MS) {
    gs.phase = 'bonus'
    gs.flying = gs.flying.filter(f => f.bonus)
    gs.aiming = false; gs.aimStart = null; gs.aimCurrent = null
    gs.truckActive = true; gs.truckX = -160
    gs.bonusIntroUntil = now + BONUS_INTRO_MS
    gs.bonusSpawnAt = gs.bonusIntroUntil + 250
    gs.bonusBannerUntil = now + BONUS_BANNER_MS
    playTruckHonk()
    if (!gs.bonusAudioStarted) { gs.bonusAudioStarted = true; startFurElise() }
  }

  if (gs.elapsed >= TOTAL_MS) {
    gs.status = 'gameover'
    gs.phase = 'throw'
    stopFurElise()
    addRecord(2, gs.score)
    if (gs.score > gs.best) gs.best = gs.score
    return
  }

  // Bin motion escalates over the throw phase: gentle drift → one-shot reorder → basketball-hoop sway
  if (gs.phase === 'throw') {
    if (gs.elapsed >= BIN_SWING_AT_MS) {
      for (const bin of gs.bins) {
        bin.x = bin.laneCx + Math.sin(now / 1000 * bin.swingSpeed + bin.swingPhase) * BIN_SWING_AMP
      }
    } else {
      if (gs.elapsed >= BIN_REORDER_AT_MS && !gs.binReorderTriggered) {
        gs.binReorderTriggered = true
        gs.binTransition = 'out'
        gs.binTransitionStart = now
        for (const bin of gs.bins) bin.outFromX = bin.x
      }
      if (gs.binTransition === 'out') {
        const p = Math.min(1, (now - gs.binTransitionStart) / BIN_TRANSITION_MS)
        const eased = p * p
        for (const bin of gs.bins) bin.x = bin.outFromX + (CW + 140 - bin.outFromX) * eased
        if (p >= 1) {
          const types = shuffle(BIN_TYPES)
          gs.bins.forEach((bin, i) => { bin.type = types[i]; bin.x = -140 })
          gs.binTransition = 'in'
          gs.binTransitionStart = now
        }
      } else if (gs.binTransition === 'in') {
        const p = Math.min(1, (now - gs.binTransitionStart) / BIN_TRANSITION_MS)
        const eased = 1 - (1 - p) * (1 - p)
        for (const bin of gs.bins) { bin.x = -140 + (bin.laneCx + 140) * eased; bin.targetX = bin.x }
        if (p >= 1) {
          gs.binTransition = 'idle'
          for (const bin of gs.bins) {
            bin.x = bin.laneCx; bin.targetX = bin.laneCx
            bin.nextRetarget = now + rng(BIN_RETARGET_MIN_MS, BIN_RETARGET_MAX_MS)
          }
        }
      } else {
        // Gentle drift within the lane, retargeting periodically
        // (kept well under half the lane spacing so neighboring bins never overlap)
        for (const bin of gs.bins) {
          if (now >= bin.nextRetarget) {
            bin.targetX = bin.laneCx + rng(-15, 15)
            bin.nextRetarget = now + rng(BIN_RETARGET_MIN_MS, BIN_RETARGET_MAX_MS)
          }
          bin.x += (bin.targetX - bin.x) * Math.min(1, dt * 2.2)
        }
      }
    }
  }

  // Garbage truck intro slide
  if (gs.truckActive) {
    gs.truckX += dt * 340
    if (gs.truckX > CW + 200) gs.truckActive = false
  }

  // Bonus spawns
  if (gs.phase === 'bonus' && now >= gs.bonusSpawnAt) {
    gs.bonusSpawnAt = now + rng(BONUS_SPAWN_MIN_MS, BONUS_SPAWN_MAX_MS)
    const t = pick(TRASH_ITEMS)
    const fromLeft = Math.random() < 0.5
    gs.flying.push({
      id: gs.idCounter++, kind: 'trash', category: t.category, icon: t.icon, label: t.label,
      x: fromLeft ? -20 : CW + 20, y: CH + 20,
      vx: fromLeft ? rng(90, 170) : -rng(90, 170),
      vy: -rng(480, 620),
      rot: 0, vrot: rng(-6, 6), bonus: true,
    })
  }

  // Flying items physics
  for (let i = gs.flying.length - 1; i >= 0; i--) {
    const it = gs.flying[i]
    it.x += it.vx * dt
    it.y += it.vy * dt
    if (it.bonus) it.vy += GRAVITY * dt // straight-line throws ignore gravity; only Bonus Time arcs
    it.rot += it.vrot * dt

    if (!it.bonus) {
      // Bin-landing check — any pass through the bin's opening counts (no arc, so no "descending" requirement)
      if (it.y >= BIN_OPEN_Y() && it.y <= BIN_OPEN_Y() + BIN_H + 10) {
        const hitBin = gs.bins.find(b => Math.abs(b.x - it.x) <= BIN_W / 2 - 6)
        if (hitBin) {
          hitBin.flashUntil = now + 260
          if (it.kind === 'decoy') {
            gs.score += SCORE_DECOY_PENALTY
            hitBin.flashGood = false
            gs.shakeUntil = now + 320
            gs.flashUntil = now + 220
            gs.flashColor = '#ff2020'
            const decoy = DECOYS.find(d => d.icon === it.icon)
            gs.lastPenaltyMsg = decoy?.penaltyMsg ?? '慘叫！！'
            addPopup(gs, it.x, it.y, `${SCORE_DECOY_PENALTY}`, '#ff4040')
            playPenalty()
          } else if (it.category === hitBin.type) {
            gs.score += SCORE_CORRECT
            hitBin.flashGood = true
            addPopup(gs, it.x, it.y, `+${SCORE_CORRECT}`, '#4ade80')
            playCorrect()
          } else {
            gs.score += SCORE_WRONG_BIN
            hitBin.flashGood = false
            addPopup(gs, it.x, it.y, `${SCORE_WRONG_BIN}`, '#f0a020')
            playWrong()
          }
          gs.flying.splice(i, 1)
          continue
        }
      }
    }

    // Off-screen cleanup (straight-line misses fly off the top with no gravity to bring them back)
    if (it.y > CH + 60 || it.y < -60 || it.x < -80 || it.x > CW + 80) {
      gs.flying.splice(i, 1)
    }
  }

  // Decoy tooltip times out if the player just sits on it without acting
  if (gs.decoyHintActive && now > gs.decoyHintUntil) gs.decoyHintActive = false

  // Popups aging
  gs.popups = gs.popups.filter(p => now - p.born < 900)

  // Slice trail decay
  if (gs.sliceTrail.length > 12) gs.sliceTrail.splice(0, gs.sliceTrail.length - 12)
}

// ─── Slice detection (Bonus Time) ──────────────────────────────────────────
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function trySlice(gs: GameState, ax: number, ay: number, bx: number, by: number, now: number) {
  for (let i = gs.flying.length - 1; i >= 0; i--) {
    const it = gs.flying[i]
    if (!it.bonus) continue
    if (distToSegment(it.x, it.y, ax, ay, bx, by) < 30) {
      gs.score += SCORE_SLICE
      addPopup(gs, it.x, it.y, `+${SCORE_SLICE}`, '#f0c040')
      playSlice()
      gs.flying.splice(i, 1)
    }
  }
  void now
}

// ─── Drawing ────────────────────────────────────────────────────────────────
function drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

const EMOJI_FONT = (size: number) => `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`

function drawBackground(ctx: CanvasRenderingContext2D, phase: 'throw' | 'bonus') {
  const sky = ctx.createLinearGradient(0, 0, 0, CH)
  if (phase === 'bonus') {
    sky.addColorStop(0, '#5a4420')
    sky.addColorStop(1, '#9a6d1e')
  } else {
    sky.addColorStop(0, '#4ea8de')
    sky.addColorStop(1, '#bfe4f5')
  }
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, CW, CH)

  // clouds
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  for (const [cx, cy, s] of [[50, 60, 1], [CW - 60, 90, 0.8], [CW * 0.55, 45, 0.6]] as const) {
    ctx.beginPath()
    ctx.ellipse(cx, cy, 28 * s, 14 * s, 0, 0, Math.PI * 2)
    ctx.ellipse(cx + 18 * s, cy + 4, 20 * s, 12 * s, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // ground / plaza
  ctx.fillStyle = '#c9c2b3'
  ctx.fillRect(0, CH - 130, CW, 130)
  ctx.fillStyle = 'rgba(0,0,0,0.06)'
  for (let x = -20; x < CW + 20; x += 34) ctx.fillRect(x, CH - 130, 2, 130)
}

function drawBins(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  for (const bin of gs.bins) {
    const def = BIN_DEFS[bin.type]
    const x = bin.x - BIN_W / 2
    const y = BIN_OPEN_Y()
    const flashing = now < bin.flashUntil
    ctx.save()
    if (flashing) {
      ctx.shadowColor = bin.flashGood ? '#4ade80' : '#ff3030'
      ctx.shadowBlur = 22
    }
    ctx.fillStyle = def.color
    drawRoundRect(ctx, x, y + 10, BIN_W, BIN_H, 10)
    ctx.fill()
    ctx.fillStyle = def.lid
    drawRoundRect(ctx, x - 4, y, BIN_W + 8, 16, 6)
    ctx.fill()
    ctx.restore()

    ctx.font = EMOJI_FONT(26)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(def.icon, bin.x, y + 40)

    ctx.font = 'bold 12px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(def.label, bin.x, y + BIN_H - 4)
  }
}

function drawFlyingItem(ctx: CanvasRenderingContext2D, it: FlyingItem) {
  ctx.save()
  ctx.translate(it.x, it.y)
  ctx.rotate(it.rot)
  if (it.bonus) {
    // Light halo so items pop against Bonus Time's dark background
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 26)
    glow.addColorStop(0, 'rgba(255,240,200,0.55)')
    glow.addColorStop(1, 'rgba(255,240,200,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(0, 0, 26, 0, Math.PI * 2)
    ctx.fill()
  }
  if (it.kind === 'decoy') {
    ctx.shadowColor = 'rgba(255,60,60,0.55)'
    ctx.shadowBlur = 16
  } else if (it.bonus) {
    ctx.shadowColor = 'rgba(0,0,0,0.7)'
    ctx.shadowBlur = 6
  }
  ctx.font = EMOJI_FONT(it.kind === 'decoy' ? 38 : 32)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(it.icon, 0, 0)
  ctx.restore()
}

// No trajectory preview — just a power bar so the player feels how hard they're pulling
function drawPowerBar(ctx: CanvasRenderingContext2D, gs: GameState) {
  if (!gs.aiming || !gs.aimStart || !gs.aimCurrent) return
  const dx = gs.aimCurrent.x - gs.aimStart.x
  const dy = gs.aimCurrent.y - gs.aimStart.y
  const dist = Math.hypot(dx, dy)
  if (dist < 6) return
  const validDir = dy < -MIN_DRAG_DIST * 0.5
  const maxDist = MAX_LAUNCH_SPEED / DRAG_K
  const ratio = Math.max(0, Math.min(1, dist / maxDist))

  const barW = 16, barH = 150
  const barX = 22
  const barBottom = THROWER_Y() + 6
  const barTop = barBottom - barH

  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.4)'
  drawRoundRect(ctx, barX, barTop, barW, barH, 8)
  ctx.fill()
  ctx.strokeStyle = validDir ? 'rgba(255,255,255,0.6)' : 'rgba(255,80,80,0.85)'
  ctx.lineWidth = 2
  drawRoundRect(ctx, barX, barTop, barW, barH, 8)
  ctx.stroke()

  const fillH = Math.max(0, barH * ratio - 4)
  if (fillH > 0) {
    const grad = ctx.createLinearGradient(0, barBottom, 0, barTop)
    grad.addColorStop(0, '#4ade80')
    grad.addColorStop(0.6, '#f0c040')
    grad.addColorStop(1, '#ff4040')
    ctx.fillStyle = validDir ? grad : 'rgba(255,80,80,0.55)'
    drawRoundRect(ctx, barX + 2, barBottom - 2 - fillH, barW - 4, fillH, 6)
    ctx.fill()
  }

  ctx.font = 'bold 11px sans-serif'
  ctx.fillStyle = validDir ? '#fff' : '#ffb0b0'
  ctx.textAlign = 'center'
  ctx.fillText(validDir ? '力道' : '↑ 需向上', barX + barW / 2, barTop - 10)
  ctx.restore()
}

function drawThrower(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  const cx = CW / 2
  const bob = Math.sin(now / 260) * 4
  ctx.font = EMOJI_FONT(48)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('🧍', cx, THROWER_Y() + 30)
  if (!gs.aiming) {
    ctx.save()
    if (gs.queueItem.kind === 'decoy') {
      ctx.shadowColor = 'rgba(255,60,60,0.65)'
      ctx.shadowBlur = 18
    }
    ctx.font = EMOJI_FONT(40)
    ctx.fillText(gs.queueItem.icon, cx, THROWER_Y() - 40 + bob)
    ctx.restore()
  }
}

// Nudges the player to swipe, until they land their first throw — most people skip the idle-screen text
function drawSwipeHint(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  if (gs.hasThrownOnce || gs.aiming) return
  const cx = CW / 2
  const bob = Math.abs(Math.sin(now / 320)) * 14
  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 6
  ctx.fillText('⬆', cx, THROWER_Y() + 55 - bob)
  ctx.font = 'bold 13px sans-serif'
  ctx.fillText('向上滑動丟出去！', cx, THROWER_Y() + 74)
  ctx.restore()
}

// One-time tooltip the first time a decoy shows up, pointing at the put-down button
function drawDecoyHint(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  if (!gs.decoyHintActive) return
  const pulse = 1 + Math.sin(now / 160) * 0.05
  const bx = CW - 51, by = THROWER_Y() - 30 // roughly where the DOM put-down button sits
  ctx.save()
  ctx.translate(CW / 2 + 10, THROWER_Y() - 90)
  ctx.scale(pulse, pulse)
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffe08a'
  ctx.shadowColor = 'rgba(0,0,0,0.7)'
  ctx.shadowBlur = 6
  ctx.fillText('⚠️ 別丟進桶子！', 0, 0)
  ctx.fillText('按右邊「放下」鍵', 0, 16)
  ctx.restore()

  // Arrow pointing from the tooltip toward the button
  ctx.save()
  ctx.strokeStyle = '#ffe08a'
  ctx.lineWidth = 2
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(CW / 2 + 40, THROWER_Y() - 78)
  ctx.lineTo(bx, by)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

// Bonus Time's gesture (drag-to-slice) isn't obvious from "click" alone — this
// animates a finger dragging back and forth with a trailing line, and keeps
// showing until the player actually drags once, however long that takes.
function drawSliceHint(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  if (gs.hasSlicedOnce || now < gs.bonusIntroUntil) return
  const cycle = 1100
  const t = (now % cycle) / cycle // 0..1
  const swing = t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5 // 0→1→0, so the hand slides out and back
  const startX = CW * 0.3, endX = CW * 0.7
  const y = CH * 0.46
  const x = startX + (endX - startX) * swing

  ctx.save()
  ctx.globalAlpha = 0.95
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  ctx.setLineDash([2, 10])
  ctx.beginPath()
  ctx.moveTo(startX, y)
  ctx.lineTo(x, y)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.font = EMOJI_FONT(36)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 8
  ctx.fillText('👆', x, y)

  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = '#fff'
  ctx.shadowBlur = 6
  ctx.fillText('手指「劃過」垃圾來消滅它！', CW / 2, y - 42)
  ctx.restore()
}

function drawPopups(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  for (const p of gs.popups) {
    const age = (now - p.born) / 900
    const alpha = 1 - age
    ctx.save()
    ctx.globalAlpha = Math.max(0, alpha)
    ctx.fillStyle = p.color
    ctx.font = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(p.text, p.x, p.y - age * 40)
    ctx.restore()
  }
}

function drawTruck(ctx: CanvasRenderingContext2D, gs: GameState) {
  if (!gs.truckActive) return
  // Kept small and tucked above the play area so it never overlaps flying items
  ctx.save()
  ctx.font = EMOJI_FONT(34)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('🚛', gs.truckX, 30)
  ctx.restore()
}

// Brief title-card beat when Bonus Time begins, instead of items just instantly appearing
function drawBonusIntro(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  const remain = gs.bonusIntroUntil - now
  if (remain <= 0) return
  const p = 1 - remain / BONUS_INTRO_MS
  const scale = p < 0.3 ? 0.6 + (p / 0.3) * 0.5 : 1 // pop in, then hold
  ctx.save()
  ctx.fillStyle = `rgba(0,0,0,${0.45 * Math.min(1, p * 4)})`
  ctx.fillRect(0, 0, CW, CH)
  ctx.translate(CW / 2, CH / 2)
  ctx.scale(scale, scale)
  ctx.font = 'bold 30px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#ffd23f'
  ctx.shadowColor = '#ff8c00'
  ctx.shadowBlur = 16
  ctx.fillText('🚛 垃圾車來襲！', 0, -14)
  ctx.font = 'bold 15px sans-serif'
  ctx.fillStyle = '#fff'
  ctx.shadowBlur = 6
  ctx.fillText('手指劃過垃圾消滅它們拿 Bonus！', 0, 20)
  ctx.restore()
}

function drawHUD(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  drawRoundRect(ctx, 8, 8, CW - 16, 46, 10)
  ctx.fill()

  ctx.textBaseline = 'middle'
  ctx.font = 'bold 13px sans-serif'
  ctx.fillStyle = '#f0c040'
  ctx.textAlign = 'left'
  ctx.fillText(`SCORE ${gs.score}`, 18, 31)

  ctx.textAlign = 'center'
  ctx.fillStyle = '#93c5fd'
  ctx.fillText(`BEST ${Math.max(gs.best, gs.score)}`, CW / 2, 31)

  const timeLeft = Math.max(0, Math.ceil((TOTAL_MS - gs.elapsed) / 1000))
  const timeToBonus = gs.phase === 'throw' ? THROW_PHASE_MS - gs.elapsed : Infinity
  const warningActive = gs.phase === 'throw' && timeToBonus > 0 && timeToBonus <= BONUS_WARNING_MS
  ctx.textAlign = 'right'
  ctx.fillStyle = gs.phase === 'bonus' ? '#ff6060' : warningActive && Math.floor(now / 260) % 2 === 0 ? '#ff6060' : '#fff'
  ctx.fillText(`⏱ ${timeLeft}s`, CW - 18, 31)

  // Warning banner counts down the last few seconds before Bonus Time so the
  // switch never feels like it comes out of nowhere
  if (warningActive) {
    const pulse = 1 + Math.sin(now / 130) * 0.08
    ctx.save()
    ctx.translate(CW / 2, 56)
    ctx.scale(pulse, pulse)
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ff8080'
    ctx.shadowColor = '#ff2020'
    ctx.shadowBlur = 8
    ctx.fillText(`⚠️ 垃圾車即將來襲！ ${Math.ceil(timeToBonus / 1000)}s`, 0, 0)
    ctx.restore()
  }

  // Banner only flashes briefly at the start of Bonus Time, tucked right under the HUD bar
  // so it never sits over the play area where flying items are
  if (gs.phase === 'bonus' && now < gs.bonusBannerUntil) {
    const pulse = 1 + Math.sin(now / 120) * 0.06
    const age = 1 - (gs.bonusBannerUntil - now) / BONUS_BANNER_MS
    ctx.save()
    ctx.globalAlpha = age > 0.7 ? 1 - (age - 0.7) / 0.3 : 1
    ctx.translate(CW / 2, 56)
    ctx.scale(pulse, pulse)
    ctx.font = 'bold 14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffd23f'
    ctx.shadowColor = '#ff8c00'
    ctx.shadowBlur = 8
    ctx.fillText('🚛 垃圾車突襲 BONUS TIME！', 0, 0)
    ctx.restore()
  }

  if (gs.lastPenaltyMsg && now < gs.flashUntil + 1600) {
    ctx.save()
    ctx.font = 'bold 14px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#ffb0b0'
    ctx.fillText(gs.lastPenaltyMsg, CW / 2, 96)
    ctx.restore()
  }
}

function render(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  ctx.save()
  if (now < gs.shakeUntil) {
    ctx.translate(rng(-6, 6), rng(-6, 6))
  }

  drawBackground(ctx, gs.phase)
  if (gs.phase === 'throw') drawBins(ctx, gs, now)
  drawTruck(ctx, gs)
  for (const it of gs.flying) drawFlyingItem(ctx, it)
  if (gs.phase === 'throw') {
    drawPowerBar(ctx, gs)
    drawThrower(ctx, gs, now)
    drawSwipeHint(ctx, gs, now)
    drawDecoyHint(ctx, gs, now)
  }
  if (gs.phase === 'bonus') drawSliceHint(ctx, gs, now)
  drawPopups(ctx, gs, now)
  drawHUD(ctx, gs, now)
  if (gs.phase === 'bonus') drawBonusIntro(ctx, gs, now)

  if (now < gs.flashUntil) {
    ctx.fillStyle = gs.flashColor
    ctx.globalAlpha = 0.35 * (1 - (now - (gs.flashUntil - 220)) / 220)
    ctx.fillRect(0, 0, CW, CH)
    ctx.globalAlpha = 1
  }

  ctx.restore()
}

// ─── Component ──────────────────────────────────────────────────────────────
interface Level2Props { onBack: () => void }

export default function Level2({ onBack }: Level2Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gsRef = useRef<GameState>(initState(getBestForLevel(2)))
  const rafRef = useRef(0)

  const [status, setStatus] = useState<'idle' | 'playing' | 'gameover'>('idle')
  const [phase, setPhase] = useState<'throw' | 'bonus'>('throw')
  const [finalScore, setFinalScore] = useState(0)
  const [portrait, setPortrait] = useState(isPortraitViewport)
  const [vpW, setVpW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 390))
  const [vpH, setVpH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 700))

  const startGame = useCallback(() => {
    const best = gsRef.current.best
    gsRef.current = initState(best)
    gsRef.current.status = 'playing'
    gsRef.current.lastFrameTs = performance.now()
    setStatus('playing')
    setPhase('throw')
  }, [])

  // ── Render loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let statusSent = gsRef.current.status
    let phaseSent = gsRef.current.phase

    const loop = (now: number) => {
      const gs = gsRef.current
      const dt = Math.min(now - gs.lastFrameTs, 50)
      gs.lastFrameTs = now
      if (gs.status === 'playing') update(gs, now, dt)
      render(ctx, gs, now)
      if (gs.phase !== phaseSent) { phaseSent = gs.phase; setPhase(gs.phase) }
      if (gs.status !== statusSent) {
        statusSent = gs.status
        if (gs.status === 'gameover') setFinalScore(gs.score)
        setStatus(gs.status)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(rafRef.current); stopFurElise() }
  }, [])

  // ── Resize / orientation ──────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      const p = isPortraitViewport()
      CW = p ? 390 : 720
      CH = p ? 700 : 480
      if (canvasRef.current) { canvasRef.current.width = CW; canvasRef.current.height = CH }
      setPortrait(p)
      setVpW(window.innerWidth)
      setVpH(window.innerHeight)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── Pointer handling ──────────────────────────────────────────────────────
  const toLocal = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const scale = CW / rect.width
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const gs = gsRef.current
    if (gs.status !== 'playing') return
    const p = toLocal(e)
    if (gs.phase === 'throw') {
      gs.aiming = true
      gs.aimStart = p
      gs.aimCurrent = p
    } else {
      gs.sliceTrail = [p]
    }
  }, [toLocal])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const gs = gsRef.current
    if (gs.status !== 'playing') return
    const p = toLocal(e)
    if (gs.phase === 'throw' && gs.aiming) {
      gs.aimCurrent = p
    } else if (gs.phase === 'bonus' && gs.sliceTrail.length) {
      gs.hasSlicedOnce = true
      const last = gs.sliceTrail[gs.sliceTrail.length - 1]
      trySlice(gs, last.x, last.y, p.x, p.y, performance.now())
      gs.sliceTrail.push(p)
    }
  }, [toLocal])

  const launch = useCallback(() => {
    const gs = gsRef.current
    if (!gs.aiming || !gs.aimStart || !gs.aimCurrent) { gs.aiming = false; return }
    // Velocity follows the finger's motion (flick-style): current − start
    const dx = gs.aimCurrent.x - gs.aimStart.x
    const dy = gs.aimCurrent.y - gs.aimStart.y
    const dist = Math.hypot(dx, dy)
    gs.aiming = false
    if (dist < MIN_DRAG_DIST || dy > -MIN_DRAG_DIST * 0.5) { gs.aimStart = null; gs.aimCurrent = null; return }

    let vx = dx * DRAG_K, vy = dy * DRAG_K
    const speed = Math.hypot(vx, vy)
    if (speed > MAX_LAUNCH_SPEED) { vx *= MAX_LAUNCH_SPEED / speed; vy *= MAX_LAUNCH_SPEED / speed }

    const q = gs.queueItem
    gs.flying.push({
      id: gs.idCounter++, kind: q.kind, category: q.category, icon: q.icon, label: q.label,
      x: CW / 2, y: THROWER_Y() - 40, vx, vy, rot: 0, vrot: rng(-4, 4), bonus: false,
    })
    gs.hasThrownOnce = true
    nextQueueItem(gs, performance.now())
    gs.aimStart = null
    gs.aimCurrent = null
  }, [])

  const onPointerUp = useCallback(() => {
    const gs = gsRef.current
    if (gs.status !== 'playing') return
    if (gs.phase === 'throw') launch()
    else gs.sliceTrail = []
  }, [launch])

  // Safe alternative to throwing — correct for decoys, penalized if used to dodge sorting real trash
  const putDown = useCallback(() => {
    const gs = gsRef.current
    if (gs.status !== 'playing' || gs.phase !== 'throw' || gs.aiming) return
    const q = gs.queueItem
    if (q.kind === 'decoy') {
      addPopup(gs, CW / 2, THROWER_Y() - 40, '安全放下 👋', '#4ade80')
    } else {
      gs.score += SCORE_PUTDOWN_WRONG
      addPopup(gs, CW / 2, THROWER_Y() - 40, `${SCORE_PUTDOWN_WRONG}`, '#f0a020')
      playWrong()
    }
    nextQueueItem(gs, performance.now())
  }, [])

  // ── Layout / scale ────────────────────────────────────────────────────────
  const logicalW = portrait ? 390 : 720
  const logicalH = portrait ? 700 : 480
  const cssScale = Math.min(vpW / logicalW, vpH / logicalH)

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute', top: '50%', left: '50%',
          width: logicalW, height: logicalH,
          transform: `translate(-50%, -50%) scale(${cssScale})`,
          transformOrigin: 'center center',
        }}
      >
        <canvas
          ref={canvasRef}
          width={logicalW}
          height={logicalH}
          style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none', cursor: 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />

        {/* Back button — hidden mid-play so it doesn't overlap the HUD */}
        {status !== 'playing' && (
          <button
            onPointerDown={onBack}
            style={{
              position: 'absolute', top: 10, left: 10, zIndex: 20,
              padding: '6px 12px', background: 'rgba(0,0,0,0.5)', color: '#fff',
              border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8,
              fontSize: 13, cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
            }}
          >← 返回</button>
        )}

        {/* Put-down button — the safe way to dispose of decoys; wrong on real trash costs points */}
        {status === 'playing' && phase === 'throw' && (
          <button
            onPointerDown={putDown}
            style={{
              position: 'absolute', right: 14, top: logicalH - 90 - 30, zIndex: 20,
              width: 74, padding: '10px 0', background: 'rgba(0,0,0,0.55)', color: '#fff',
              border: '2px solid rgba(255,255,255,0.4)', borderRadius: 12,
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'sans-serif',
              touchAction: 'manipulation', userSelect: 'none',
            }}
          >🖐️ 放下</button>
        )}

        {/* Idle screen */}
        {status === 'idle' && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(8,16,36,0.94)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 20, gap: 10, textAlign: 'center', fontFamily: 'sans-serif', color: '#fff',
          }}>
            <div style={{ fontSize: 46 }}>♻️</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#60a5fa' }}>垃圾分類王</div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, maxWidth: 320 }}>
              🎯 向上滑動把垃圾丟進正確的桶子！<br />
              🙅 混進來的「老人家」「女友」別丟進桶子！<br />
              🚛 最後倒數垃圾車會來襲，手指劃過垃圾消滅它們拿 Bonus！
            </div>
            <div style={{ fontSize: 11, color: '#7a8bab' }}>
              （放心，遊戲中會即時提示怎麼玩）
            </div>
            <button
              onPointerDown={startGame}
              style={{
                marginTop: 10, padding: '12px 32px', background: 'linear-gradient(135deg,#2f6fd6,#1c4fa8)',
                color: '#fff', border: '2px solid #60a5fa', borderRadius: 12, fontSize: 17, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
              }}
            >開始遊戲 →</button>
          </div>
        )}

        {/* Gameover screen */}
        {status === 'gameover' && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(8,16,36,0.94)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 12, fontFamily: 'sans-serif', color: '#fff',
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: '#f0c040' }}>時間到！</div>
            <div style={{ fontSize: 34, fontWeight: 800 }}>{finalScore} 分</div>
            <div style={{ fontSize: 14, color: '#93c5fd' }}>最高分：{Math.max(gsRef.current.best, finalScore)}</div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <button
                onPointerDown={startGame}
                style={{
                  padding: '10px 22px', background: 'linear-gradient(135deg,#2f6fd6,#1c4fa8)', color: '#fff',
                  border: '2px solid #60a5fa', borderRadius: 10, fontSize: 15, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
                }}
              >再玩一次</button>
              <button
                onPointerDown={onBack}
                style={{
                  padding: '10px 22px', background: 'rgba(255,255,255,0.1)', color: '#fff',
                  border: '2px solid rgba(255,255,255,0.3)', borderRadius: 10, fontSize: 15,
                  cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
                }}
              >返回大廳</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
