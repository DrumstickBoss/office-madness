// ─── Lobby background music — a looping 8-bit/chiptune tune, synthesized live ──
// with the Web Audio API (no audio assets), styled after classic NES sound
// chips: a square-wave lead, a triangle-wave bass, and a noise-channel hi-hat.

let audioCtx: AudioContext | null = null
const getCtx = (): AudioContext | null => {
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

// Nodes from the currently-scheduled cycle — kept so stopLobbyBgm() can cut them
// off immediately instead of letting already-scheduled notes play out (this matters
// because React StrictMode mounts effects twice in dev, which would otherwise
// schedule two overlapping copies of the first cycle).
let activeNodes: Array<OscillatorNode | AudioBufferSourceNode> = []

function playToneAt(ctx: AudioContext, freq: number, dur: number, type: OscillatorType, gain: number, startTime: number) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(ctx.destination)
  // Quick attack (avoids a click), then decay across the note's duration
  g.gain.setValueAtTime(0.0001, startTime)
  g.gain.exponentialRampToValueAtTime(gain, startTime + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + dur)
  osc.start(startTime)
  osc.stop(startTime + dur + 0.02)
  activeNodes.push(osc)
}

// One shared noise buffer reused for every hi-hat hit (cheaper than regenerating each time)
let noiseBuffer: AudioBuffer | null = null
const getNoiseBuffer = (ctx: AudioContext): AudioBuffer => {
  if (!noiseBuffer) {
    const len = Math.floor(ctx.sampleRate * 0.05)
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  }
  return noiseBuffer
}

function playHatAt(ctx: AudioContext, dur: number, gain: number, startTime: number) {
  const src = ctx.createBufferSource()
  src.buffer = getNoiseBuffer(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 6000 // strips the low end so it ticks like a hi-hat, not a thud
  const g = ctx.createGain()
  g.gain.setValueAtTime(gain, startTime)
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + dur)
  src.connect(hp)
  hp.connect(g)
  g.connect(ctx.destination)
  src.start(startTime)
  src.stop(startTime + dur + 0.02)
  activeNodes.push(src)
}

// ─── Composition: 8-bar loop, I–vi–IV–V progression (C–Am–F–G), 2 bars each ───
const EIGHTH = 0.16 // seconds per 8th note — ~187 BPM feel, upbeat but not frantic
const BAR = EIGHTH * 8

// Notes (Hz). 0 = rest.
const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880.0, C6 = 1046.5
const A4 = 440.0, B4 = 493.88, F4 = 349.23, G4 = 392.0

// Each row is one bar of 8th notes — arpeggios through the chord of the moment.
const MELODY_BARS: number[][] = [
  [C5, E5, G5, C6, G5, E5, C5, 0],       // C
  [E5, G5, C6, G5, E5, D5, C5, 0],       // C
  [A4, C5, E5, A5, E5, C5, A4, 0],       // Am
  [C5, E5, A5, E5, C5, B4, A4, 0],       // Am
  [F4, A4, C5, F5, C5, A4, F4, 0],       // F
  [A4, C5, F5, C5, A4, G4, F4, 0],       // F
  [G4, B4, D5, G5, D5, B4, G4, 0],       // G
  [B4, D5, G5, D5, B4, A4, G4, 0],       // G — resolves back into C for a seamless loop
]

// Root note held for each bar (triangle-wave "NES bass channel")
const C3 = 130.81, A2 = 110.0, F2 = 87.31, G2 = 98.0
const BASS_BARS = [C3, C3, A2, A2, F2, F2, G2, G2]

interface Note { t: number; freq: number; dur: number; type: OscillatorType; gain: number }
interface Loop { notes: Note[]; hats: number; loopLen: number }

function buildLoop(): Loop {
  const notes: Note[] = []
  MELODY_BARS.forEach((bar, bi) => {
    bar.forEach((freq, si) => {
      if (freq > 0) notes.push({ t: bi * BAR + si * EIGHTH, freq, dur: EIGHTH * 0.7, type: 'square', gain: 0.07 })
    })
  })
  BASS_BARS.forEach((freq, bi) => {
    notes.push({ t: bi * BAR, freq, dur: BAR * 0.92, type: 'triangle', gain: 0.09 })
  })
  return { notes, hats: MELODY_BARS.length * 8, loopLen: BAR * MELODY_BARS.length }
}

const LOOP = buildLoop()

// ─── Scheduler ──────────────────────────────────────────────────────────────
// Each cycle's notes are scheduled up front against the AudioContext's own
// clock (sample-accurate); only the cycle-to-cycle re-arm goes through
// setTimeout, so any JS timer jitter only ever lands at the (silent) loop
// boundary instead of smearing every note.
let bgmTimer: ReturnType<typeof setTimeout> | null = null
let bgmPlaying = false

function scheduleCycle(ctx: AudioContext, cycleStart: number) {
  activeNodes = [] // previous cycle has already finished playing by the time the next one starts
  for (const n of LOOP.notes) playToneAt(ctx, n.freq, n.dur, n.type, n.gain, cycleStart + n.t)
  for (let i = 0; i < LOOP.hats; i++) playHatAt(ctx, 0.04, 0.025, cycleStart + i * EIGHTH)
}

export function startLobbyBgm(): void {
  if (bgmPlaying) return
  const ctx = getCtx()
  if (!ctx) return
  bgmPlaying = true
  const tick = () => {
    if (!bgmPlaying) return
    const cycleStart = ctx.currentTime + 0.05
    scheduleCycle(ctx, cycleStart)
    bgmTimer = setTimeout(tick, LOOP.loopLen * 1000)
  }
  tick()
}

export function stopLobbyBgm(): void {
  bgmPlaying = false
  if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null }
  // Cut off anything already scheduled (including notes queued by a StrictMode
  // double-mount) instead of letting a stale cycle keep sounding.
  if (audioCtx) {
    for (const node of activeNodes) { try { node.stop(audioCtx.currentTime) } catch { /* already stopped */ } }
  }
  activeNodes = []
}

// ─── Mute preference (localStorage) ────────────────────────────────────────
const MUTE_KEY = 'bentoBlitz_bgmMuted'
export const loadBgmMuted = (): boolean => {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
export const saveBgmMuted = (muted: boolean): void => {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0') } catch {}
}
