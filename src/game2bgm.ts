// ─── Level 2 background music — a looping 8-bit/chiptune tune, synthesized live ──
// with the Web Audio API (no audio assets). Deliberately a different mood from
// the Lobby's bgm.ts — a mellower triangle-wave lead over a rounded sine bass
// and a light off-beat shaker (instead of the Lobby's square-lead + driving
// straight-8th hi-hat), so this reads as relaxed and cheerful rather than the
// Lobby's brisk arcade feel.

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

// Nodes from the currently-scheduled cycle — kept so stopGame2Bgm() can cut them
// off immediately instead of letting already-scheduled notes play out (matters
// for React StrictMode's double-mount in dev, same as the Lobby's bgm.ts).
let activeNodes: Array<OscillatorNode | AudioBufferSourceNode> = []

function playToneAt(ctx: AudioContext, freq: number, dur: number, type: OscillatorType, gain: number, startTime: number) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(ctx.destination)
  g.gain.setValueAtTime(0.0001, startTime)
  g.gain.exponentialRampToValueAtTime(gain, startTime + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + dur)
  osc.start(startTime)
  osc.stop(startTime + dur + 0.02)
  activeNodes.push(osc)
}

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
  hp.frequency.value = 6000
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

// ─── Composition: 8-bar loop, C–Am–F–G (I–vi–IV–V) in C major, 2 bars each ──
// A gentle, skipping rhythm — every other 8th note is a rest — instead of a
// dense walking arpeggio, so it breathes more and feels like a relaxed stroll
// rather than a drive.
const EIGHTH = 0.2
const BAR = EIGHTH * 8

const F4 = 349.23, G4 = 392.0, A4 = 440.0, B4 = 493.88,
  C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880.0, C6 = 1046.5

const MELODY_BARS: number[][] = [
  [C5, 0, E5, G5, 0, E5, C5, 0],          // C
  [E5, 0, G5, C6, 0, G5, E5, 0],          // C
  [A4, 0, C5, E5, 0, C5, A4, 0],          // Am
  [C5, 0, E5, A5, 0, E5, C5, 0],          // Am
  [F4, 0, A4, C5, 0, A4, F4, 0],          // F
  [A4, 0, C5, F5, 0, C5, A4, 0],          // F
  [G4, 0, B4, D5, 0, B4, G4, 0],          // G
  [B4, 0, D5, G5, 0, D5, G4, 0],          // G — resolves back into C at the top of the loop
]

const C3 = 130.81, A2 = 110.0, F2 = 87.31, G2 = 98.0
const BASS_BARS = [C3, C3, A2, A2, F2, F2, G2, G2]

interface Note { t: number; freq: number; dur: number; type: OscillatorType; gain: number }
interface Loop { notes: Note[]; hatTimes: number[]; loopLen: number }

function buildLoop(): Loop {
  const notes: Note[] = []
  MELODY_BARS.forEach((bar, bi) => {
    bar.forEach((freq, si) => {
      // Triangle-wave lead (mellower/rounder than a square lead) over a sine-wave
      // bass — softer and warmer than the Lobby's square-lead chiptune sound.
      if (freq > 0) notes.push({ t: bi * BAR + si * EIGHTH, freq, dur: EIGHTH * 0.85, type: 'triangle', gain: 0.1 })
    })
  })
  BASS_BARS.forEach((freq, bi) => {
    notes.push({ t: bi * BAR, freq, dur: BAR * 0.9, type: 'sine', gain: 0.11 })
  })
  // Light shaker on just the off-beats (the "and" of each beat) instead of a
  // straight 8th hi-hat — keeps a gentle sway going without feeling driven.
  const hatTimes: number[] = []
  for (let bi = 0; bi < MELODY_BARS.length; bi++) {
    for (let si = 0; si < 4; si++) hatTimes.push(bi * BAR + (si * 2 + 1) * EIGHTH)
  }
  return { notes, hatTimes, loopLen: BAR * MELODY_BARS.length }
}

const LOOP = buildLoop()

// ─── Scheduler ──────────────────────────────────────────────────────────────
let bgmTimer: ReturnType<typeof setTimeout> | null = null
let bgmPlaying = false

function scheduleCycle(ctx: AudioContext, cycleStart: number) {
  activeNodes = []
  for (const n of LOOP.notes) playToneAt(ctx, n.freq, n.dur, n.type, n.gain, cycleStart + n.t)
  for (const t of LOOP.hatTimes) playHatAt(ctx, 0.05, 0.018, cycleStart + t)
}

export function startGame2Bgm(): void {
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

export function stopGame2Bgm(): void {
  bgmPlaying = false
  if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null }
  if (audioCtx) {
    for (const node of activeNodes) { try { node.stop(audioCtx.currentTime) } catch { /* already stopped */ } }
  }
  activeNodes = []
}
