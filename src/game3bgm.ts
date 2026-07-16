// ─── Level 3 background music — 運動會進行曲 (sports-day march) ────────────────
// Synthesized live with the Web Audio API (no audio assets), in the same
// 8-bit/chiptune voice as the Lobby's bgm.ts: a square-wave lead, a triangle-wave
// bass and a noise-channel hi-hat. Where the Lobby loops a laid-back arpeggio,
// this one is a bright, triumphant C-major march — repeated-note brass fanfare on
// the lead, a classic "oom-pah" bass (root on the beat, fifth off it), and a
// kick+snare backbeat — to drive the obstacle run like a school athletics meet.

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

// Nodes from the currently-scheduled cycle — kept so stopLevel3Bgm() can cut them
// off immediately instead of letting already-scheduled notes play out (matters for
// React StrictMode's double-mount in dev, same as the Lobby's bgm.ts).
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

// Kick drum — sine pitch-dropping from 150Hz to 45Hz, the marching downbeat
function playKickAt(ctx: AudioContext, startTime: number) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150, startTime)
  osc.frequency.exponentialRampToValueAtTime(45, startTime + 0.1)
  g.gain.setValueAtTime(0.28, startTime)
  g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.14)
  osc.connect(g)
  g.connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + 0.16)
  activeNodes.push(osc)
}

// Snare — bandpass-filtered noise, the backbeat crack of a marching-band drum
function playSnareAt(ctx: AudioContext, startTime: number, gain = 0.18) {
  const len = Math.floor(ctx.sampleRate * 0.13)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7
  const g = ctx.createGain()
  g.gain.setValueAtTime(gain, startTime)
  g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.1)
  src.connect(bp); bp.connect(g); g.connect(ctx.destination)
  src.start(startTime); src.stop(startTime + 0.12)
  activeNodes.push(src)
}

// ─── Composition: 8-bar C-major march, felt in a fast 2 (galop-like) ─────────
const EIGHTH = 0.15 // seconds per 8th note — ~200 BPM feel, brisk and driving
const BEAT = EIGHTH * 2
const BAR = EIGHTH * 8

// Notes (Hz). 0 = rest.
const G4 = 392.0, B4 = 493.88
const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880.0
const C6 = 1046.5

// Square-wave lead — a repeated-note brass fanfare with a clear march contour:
// a rising call, a cadence at bar 4, a bright answer, then a turnaround (bar 8)
// that lifts back to the top of the loop. Each row is one bar of 8th notes.
const MELODY_BARS: number[][] = [
  [G4, G4, C5, C5, E5, 0, E5, 0],   // C  — bugle call, up from the fifth below
  [D5, D5, G5, 0, E5, 0, C5, 0],    // G7 — answer
  [E5, E5, G5, G5, C6, 0, G5, 0],   // C  — reach the octave
  [G5, F5, E5, D5, C5, 0, 0, 0],    // G7→C — run down to the cadence
  [A5, A5, F5, 0, A5, 0, F5, 0],    // F  — bright lift
  [G5, G5, E5, 0, G5, 0, E5, 0],    // C  — settle back
  [F5, 0, E5, 0, D5, 0, B4, 0],     // F→G7 — step down, build tension
  [C5, 0, D5, 0, E5, 0, G5, 0],     // G7→C — turnaround, climbs into the loop top
]

// Triangle-wave "oom-pah" bass: root note on beats 1 & 3, fifth on beats 2 & 4.
// [root, fifth] per bar — the marching left-hand under the fanfare.
const C3 = 130.81, G3 = 196.0, G2 = 98.0, D3 = 146.83, F2 = 87.31
const BASS_BARS: Array<[number, number]> = [
  [C3, G3], // C
  [G2, D3], // G
  [C3, G3], // C
  [G2, D3], // G
  [F2, C3], // F
  [C3, G3], // C
  [G2, D3], // G (via F)
  [G2, D3], // G — dominant, pulls back to C
]

interface Note { t: number; freq: number; dur: number; type: OscillatorType; gain: number }
interface Loop { notes: Note[]; loopLen: number }

function buildLoop(): Loop {
  const notes: Note[] = []
  MELODY_BARS.forEach((bar, bi) => {
    bar.forEach((freq, si) => {
      if (freq > 0) notes.push({ t: bi * BAR + si * EIGHTH, freq, dur: EIGHTH * 0.68, type: 'square', gain: 0.07 })
    })
  })
  // Oom-pah bass — one short note on each of the 4 beats per bar
  BASS_BARS.forEach(([root, fifth], bi) => {
    for (let beat = 0; beat < 4; beat++) {
      const freq = beat % 2 === 0 ? root : fifth
      notes.push({ t: bi * BAR + beat * BEAT, freq, dur: BEAT * 0.55, type: 'triangle', gain: 0.09 })
    }
  })
  return { notes, loopLen: BAR * MELODY_BARS.length }
}

const LOOP = buildLoop()

// ─── Scheduler ──────────────────────────────────────────────────────────────
// Each cycle's notes are scheduled up front against the AudioContext's own clock
// (sample-accurate); only the cycle-to-cycle re-arm goes through setTimeout, so
// any JS timer jitter only ever lands at the loop boundary instead of smearing
// every note. (Same design as the Lobby's bgm.ts.)
let bgmTimer: ReturnType<typeof setTimeout> | null = null
let bgmPlaying = false

function scheduleCycle(ctx: AudioContext, cycleStart: number) {
  activeNodes = [] // previous cycle has already finished playing by the time the next one starts
  for (const n of LOOP.notes) playToneAt(ctx, n.freq, n.dur, n.type, n.gain, cycleStart + n.t)

  const bars = MELODY_BARS.length
  for (let bi = 0; bi < bars; bi++) {
    const barStart = cycleStart + bi * BAR
    // Kick on beats 1 & 3, snare backbeat on 2 & 4 — a tight marching-band drive
    playKickAt(ctx, barStart)
    playKickAt(ctx, barStart + 2 * BEAT)
    playSnareAt(ctx, barStart + BEAT)
    playSnareAt(ctx, barStart + 3 * BEAT)
    // Straight-8th hi-hat, downbeats a touch louder
    for (let e = 0; e < 8; e++) {
      playHatAt(ctx, 0.04, e % 2 === 0 ? 0.026 : 0.016, barStart + e * EIGHTH)
    }
  }
}

export function startLevel3Bgm(): void {
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

export function stopLevel3Bgm(): void {
  bgmPlaying = false
  if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null }
  // Cut off anything already scheduled (including a StrictMode double-mount)
  // instead of letting a stale cycle keep sounding.
  if (audioCtx) {
    for (const node of activeNodes) { try { node.stop(audioCtx.currentTime) } catch { /* already stopped */ } }
  }
  activeNodes = []
}
