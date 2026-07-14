// ─── 接便當遊戲 BGM + SFX — EDM 電音風格 ────────────────────────────────────
// 4-on-the-floor 踢鼓、2&4 軍鼓、8 分音符 hi-hat、A 小調和聲進行
// BPM 從 128 線性加速至 175（60 秒後），節奏越快越緊張
// 電話音效：buzz 震動 + 雙音鈴聲（連續震動由 GameCanvas 控制）

let audioCtx: AudioContext | null = null

const getCtx = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audioCtx = new Ctor()
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    return audioCtx
  } catch {
    return null
  }
}

let activeNodes: Array<OscillatorNode | AudioBufferSourceNode> = []

// ─── 音符排程工具 ─────────────────────────────────────────────────────────────

function schedOsc(
  ctx: AudioContext,
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  t0: number,
) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  osc.connect(g)
  g.connect(ctx.destination)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
  activeNodes.push(osc)
}

// 鋸齒波 bass + lowpass filter，製造溫暖的 EDM bass pump
function schedBass(ctx: AudioContext, freq: number, dur: number, t0: number) {
  const osc = ctx.createOscillator()
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = freq * 3.5
  const g = ctx.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = freq
  osc.connect(lp)
  lp.connect(g)
  g.connect(ctx.destination)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
  activeNodes.push(osc)
}

// 踢鼓：正弦波從 160Hz 快速下滑至 40Hz
function schedKick(ctx: AudioContext, t0: number) {
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(160, t0)
  osc.frequency.exponentialRampToValueAtTime(40, t0 + 0.1)
  g.gain.setValueAtTime(0.3, t0)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14)
  osc.connect(g)
  g.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + 0.16)
  activeNodes.push(osc)
}

// 軍鼓：帶通濾波噪音，清脆打擊感
function schedSnare(ctx: AudioContext, t0: number) {
  const len = Math.floor(ctx.sampleRate * 0.14)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.6
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.22, t0)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.11)
  src.connect(bp); bp.connect(g); g.connect(ctx.destination)
  src.start(t0); src.stop(t0 + 0.13)
  activeNodes.push(src)
}

// Hi-hat：高通濾波噪音
let hatBuffer: AudioBuffer | null = null
function getHatBuffer(ctx: AudioContext): AudioBuffer {
  if (!hatBuffer) {
    const len = Math.floor(ctx.sampleRate * 0.05)
    hatBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = hatBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  return hatBuffer
}
function schedHat(ctx: AudioContext, gain: number, t0: number) {
  const src = ctx.createBufferSource()
  src.buffer = getHatBuffer(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'; hp.frequency.value = 7000
  const g = ctx.createGain()
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03)
  src.connect(hp); hp.connect(g); g.connect(ctx.destination)
  src.start(t0); src.stop(t0 + 0.04)
  activeNodes.push(src)
}

// ─── 旋律：A 小調和聲（Am–Am–Dm–E7），4 小節循環 ──────────────────────────
// Am: A C E | Dm: D F A | E7: E G# B
const A4=440.0, B4=493.88, C5=523.25, D5=587.33, E5=659.25, F5=698.46
const G5=783.99, A5=880.0
const Gs4=415.30 // G# — 和聲小調特色音，製造 E7 緊張感
const A2=110.0, D3=146.83, E3=164.81

// 每小節 8 個八分音符（0 = 切音休止，製造 EDM 節奏感）
const MELODY: number[][] = [
  // Am — 上拍起、切分節奏製造彈跳感
  [0, A5, 0, G5, E5, G5, A5, G5],
  // Am — 下行解決
  [E5, G5, A5, G5, E5, C5, A4, 0],
  // Dm — 繃緊
  [0, D5, 0, F5, A5, F5, D5, 0],
  // E7 — 屬和弦張力，解決回 Am
  [E5, 0, B4, Gs4, E5, B4, Gs4, 0],
]
// 各小節低音根音
const BASS_ROOTS: number[] = [A2, A2, D3, E3]

// ─── 以當前 BPM 組建一個循環 ────────────────────────────────────────────────
function buildCycle(bpm: number) {
  const BEAT = 60 / bpm           // 四分音符（1拍）秒數
  const E8   = BEAT / 2           // 八分音符秒數
  const BAR  = BEAT * 4           // 一小節（4拍）秒數
  const BARS = MELODY.length      // 共 4 小節

  type NoteEvent = { t: number; f: number; d: number; type: OscillatorType; g: number }
  const notes: NoteEvent[] = []

  // 方波旋律
  MELODY.forEach((bar, bi) => {
    bar.forEach((freq, si) => {
      if (freq > 0)
        notes.push({ t: bi * BAR + si * E8, f: freq, d: E8 * 0.62, type: 'square', g: 0.07 })
    })
  })

  return { notes, loopLen: BAR * BARS, E8, BEAT, BAR, BARS }
}

// ─── BGM 排程器 ──────────────────────────────────────────────────────────────
let bgmPlaying = false
let bgmTimer: ReturnType<typeof setTimeout> | null = null
let getBpmFn: (() => number) | null = null

function doSchedule(ctx: AudioContext, cycleStart: number): number {
  const bpm = getBpmFn ? getBpmFn() : 128
  activeNodes = []
  const cycle = buildCycle(bpm)

  // 旋律
  for (const n of cycle.notes)
    schedOsc(ctx, n.f, n.d, n.type, n.g, cycleStart + n.t)

  for (let bi = 0; bi < cycle.BARS; bi++) {
    const barStart = cycleStart + bi * cycle.BAR

    // Bass pump：每拍短促一擊（4 次/小節），製造 EDM 抽拉感
    const bassFreq = BASS_ROOTS[bi]
    for (let beat = 0; beat < 4; beat++) {
      schedBass(ctx, bassFreq, cycle.BEAT * 0.38, barStart + beat * cycle.BEAT)
    }

    // 踢鼓：4-on-the-floor（每拍）
    for (let beat = 0; beat < 4; beat++) {
      schedKick(ctx, barStart + beat * cycle.BEAT)
    }

    // 軍鼓：第 2 拍、第 4 拍（off-beats）
    schedSnare(ctx, barStart + cycle.BEAT)
    schedSnare(ctx, barStart + 3 * cycle.BEAT)

    // Hi-hat：每個八分音符，強拍略大聲
    for (let e = 0; e < 8; e++) {
      const isDownbeat = e % 2 === 0
      schedHat(ctx, isDownbeat ? 0.022 : 0.014, barStart + e * cycle.E8)
    }
  }

  return cycle.loopLen
}

/**
 * 開始 EDM BGM。
 * @param getBpm 每循環起點呼叫，回傳當前 BPM（建議 128~175）
 */
export function startGame1Bgm(getBpm: () => number): void {
  if (bgmPlaying) return
  const ctx = getCtx()
  if (!ctx) return
  bgmPlaying = true
  getBpmFn = getBpm

  const tick = () => {
    if (!bgmPlaying) return
    const loopLen = doSchedule(ctx, ctx.currentTime + 0.05)
    bgmTimer = setTimeout(tick, loopLen * 1000)
  }
  tick()
}

/** 立即停止 BGM */
export function stopGame1Bgm(): void {
  bgmPlaying = false
  getBpmFn = null
  if (bgmTimer) { clearTimeout(bgmTimer); bgmTimer = null }
  if (audioCtx) {
    for (const node of activeNodes) {
      try { node.stop(audioCtx.currentTime) } catch { /* already stopped */ }
    }
  }
  activeNodes = []
}

// ─── 電話來電音效：乾淨雙音鈴聲 ─────────────────────────────────────────────
// 只播放方波鈴聲旋律；連續震動由 GameCanvas 的 useEffect 控制
export function playPhoneRing(): void {
  const ctx = getCtx()
  if (!ctx) return
  const t0 = ctx.currentTime

  // E6–A5 雙音，兩次，模擬傳統電話鈴聲節奏
  const RING: Array<{ f: number; dt: number }> = [
    { f: 1318.5, dt: 0.0  }, // E6
    { f: 880.0,  dt: 0.12 }, // A5
    { f: 1318.5, dt: 0.32 }, // E6
    { f: 880.0,  dt: 0.44 }, // A5
  ]
  for (const { f, dt } of RING) {
    const t = t0 + dt
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'square'; osc.frequency.value = f
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1)
    osc.connect(g); g.connect(ctx.destination)
    osc.start(t); osc.stop(t + 0.12)
  }
}

// ─── 遊戲 SFX ────────────────────────────────────────────────────────────────
function immediateTone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0) {
  const ctx = getCtx()
  if (!ctx) return
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type; osc.frequency.value = freq
  osc.connect(g); g.connect(ctx.destination)
  const t0 = ctx.currentTime + delay
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
  osc.start(t0); osc.stop(t0 + dur + 0.02)
}

/** 接到今日特餐：三音上行叮聲 */
export function playSpecialCatch(): void {
  immediateTone(523.25, 0.1,  'square', 0.11)
  immediateTone(659.25, 0.1,  'square', 0.10, 0.08)
  immediateTone(783.99, 0.16, 'square', 0.11, 0.16)
}

/** 接到錯誤便當：下行悶響 */
export function playWrongCatch(): void {
  immediateTone(440, 0.06, 'square',   0.09)
  immediateTone(277, 0.18, 'sawtooth', 0.13, 0.06)
}

/** 被凍結（接錯電話 / 漏接）：刺耳下滑音 */
export function playFreezeSound(): void {
  immediateTone(330, 0.28, 'sawtooth', 0.13)
  immediateTone(220, 0.32, 'sawtooth', 0.11, 0.2)
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate([60, 40, 180]) } catch {}
  }
}

/** 正確接聽 / 掛斷電話：短促上揚音 */
export function playPhoneCorrect(): void {
  immediateTone(880,    0.08, 'square', 0.1)
  immediateTone(1108.7, 0.11, 'square', 0.09, 0.08)
}
