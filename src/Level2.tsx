import { useRef, useEffect, useState, useCallback } from "react";
import { addRecord, getBestForLevel } from "./leaderboard";
import { startGame2Bgm, stopGame2Bgm } from "./game2bgm";
import game2BgSrc from "./assets/game2_bgm.mp4";
import game2InfoSrc from "./assets/game2_info.png";

// ─── Canvas dimensions ────────────────────────────────────────────────────
// The canvas fills the real viewport pixel-for-pixel (same approach as
// GameCanvas) instead of being drawn small and CSS-scaled up — that scale-up
// was the source of the blurry/letterboxed look. All game logic below still
// runs in a fixed logical coordinate space (LW × LH); GS maps logical →
// physical pixels and is applied once via ctx.scale() in render().
const isPortraitViewport = () =>
  typeof window !== "undefined" && window.innerWidth < window.innerHeight;

let CW = typeof window !== "undefined" ? window.innerWidth : 390;
let CH = typeof window !== "undefined" ? window.innerHeight : 700;

const _p0 = typeof window !== "undefined" && isPortraitViewport();
let LW = _p0 ? 390 : 720;
let GS =
  typeof window !== "undefined"
    ? _p0
      ? CW / LW
      : Math.min(CW / LW, CH / 480)
    : 1;
let LH = typeof window !== "undefined" ? Math.round(CH / GS) : _p0 ? 700 : 480;

// ─── Game tuning ───────────────────────────────────────────────────────────
const THROW_PHASE_MS = 45_000;
// 垃圾車小遊戲（Bonus Time）的遊戲時間在這裡調整。
const BONUS_PHASE_MS = 20_000;
const TOTAL_MS = THROW_PHASE_MS + BONUS_PHASE_MS;
// 垃圾車進場動畫的速度（px/s）— 數字越大，垃圾車開得越快、進場動畫越快結束。
const TRUCK_SPEED = 480;
const GRAVITY = 420; // px/s² — only applied to Bonus Time items; low enough that they arc up to mid-screen
const DRAG_K = 4.2; // swipe px → launch velocity px/s (throws travel in a straight line)
const MAX_LAUNCH_SPEED = 900;
const MIN_DRAG_DIST = 45;
const SCORE_CORRECT = 100;
const SCORE_WRONG_BIN = -30;
const SCORE_DECOY_PENALTY = -500;
const SCORE_DECOY_CORRECT = 100; // correctly throwing a decoy into its correct side target
const SCORE_CATCH = 50; // Bonus Time — catching a falling item in the net
// Bonus Time's catching net — size of the sprite, and how close an item's
// center has to get to the net's center to count as caught.
const NET_SIZE = 96;
const NET_CATCH_R = 42;
// Player holds BATCH_SIZE items at once (free pick, any order); once every
// slot has been thrown, a fresh batch refills all of them at once.
const BATCH_SIZE = 3;
// ▼▼▼ 手上三個物品的大小在這裡調整 ▼▼▼
const BATCH_SLOT_GAP = 74; // 三個物品彼此之間的水平間距 — 物品變大時可以跟著加大，避免互相重疊
const BATCH_ITEM_SIZE = 58; // 一般垃圾物品的大小
const BATCH_DECOY_SIZE = 82; // 誘餌（老人／女友）物品的大小
const BATCH_SLOT_HIT_R = 34; // how close a pointer-down must land to a slot to start aiming it
const BIN_W = 92;
const BIN_H = 78;
// Fast throws are stepped this many times per frame so they can't skip over
// a bin/side-target's whole hitbox in a single jump (see checkThrowLanding).
const BIN_COLLISION_SUBSTEPS = 4;
const BIN_REORDER_AT_MS = 15_000; // bins slide off-screen once and re-enter in a shuffled order — their only motion now
const BIN_REORDER_WARNING_MS = 4000; // small countdown hint before the reorder kicks in
const BIN_TRANSITION_MS = 420;
const BONUS_SPAWN_MIN_MS = 380;
const BONUS_SPAWN_MAX_MS = 640;
const BONUS_BANNER_MS = 2200;
const BONUS_WARNING_MS = 5000; // flash a "here it comes" warning for the last 5s of the throw phase
const BONUS_INTRO_MS = 1300; // beat of "🚛 垃圾車來襲！" before bonus items start spawning — no more instant cut
const DECOY_HINT_MS = 6000; // how long the first-ever decoy's "don't throw me" tooltip stays up

// ─── Bin / item catalogue ───────────────────────────────────────────────────
type BinType = "general" | "recycle" | "food";

interface BinVisual {
  type: BinType;
  label: string;
  icon: string;
  color: string;
  lid: string;
}
const BIN_DEFS: Record<BinType, BinVisual> = {
  recycle: {
    type: "recycle",
    label: "資源回收",
    icon: "♻️",
    color: "#2f6fd6",
    lid: "#1c4fa8",
  },
  food: {
    type: "food",
    label: "廚餘",
    icon: "🐟",
    color: "#2f9e52",
    lid: "#1c7a3a",
  },
  general: {
    type: "general",
    label: "一般垃圾",
    icon: "🗑️",
    color: "#d6432f",
    lid: "#a82f1c",
  },
};
const BIN_TYPES: BinType[] = ["recycle", "food", "general"];

// Trash can sprites — one color per bin type, three frames each (idle / lid
// opening / lid open). Preloaded up front like GameCanvas's meal sprites.
const BIN_COLOR: Record<BinType, string> = {
  recycle: "blue",
  food: "Green",
  general: "red",
};
const BIN_IMG_CACHE = new Map<string, HTMLImageElement>();
(["blue", "Green", "red"] as const).forEach((color) => {
  for (let frame = 1; frame <= 3; frame++) {
    const key = `${color}-${frame}`;
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}sprites/stage2/trashcan/${key}.gif`;
    BIN_IMG_CACHE.set(key, img);
  }
});
// How long the lid stays on frame 2 / frame 3 after trash lands, before resetting to frame 1
const BIN_OPEN_FRAME2_MS = 100;
const BIN_OPEN_FRAME3_MS = 700;

interface TrashDef {
  category: BinType;
  icon: string; // filename under sprites/stage2/ (trash sprite key)
  label: string;
}
const TRASH_ITEMS: TrashDef[] = [
  { category: "recycle", icon: "recycle-1.png", label: "寶特瓶" },
  { category: "recycle", icon: "recycle-3.png", label: "廢紙" },
  { category: "recycle", icon: "recycle-2.png", label: "沐浴乳瓶" },
  { category: "recycle", icon: "recycle-4.png", label: "手搖飲料杯" },
  { category: "food", icon: "food-4.png", label: "香蕉皮" },
  { category: "food", icon: "food-1.png", label: "蘋果核" },
  { category: "food", icon: "food-6.png", label: "剩飯" },
  { category: "general", icon: "general-1.png", label: "衛生紙" },
  { category: "general", icon: "general-2.png", label: "糖果包裝紙" },
  { category: "general", icon: "general-3.png", label: "舊牙刷" },
];
// Trash-item sprites — preloaded up front, same pattern as BIN_IMG_CACHE.
const TRASH_IMG_CACHE = new Map<string, HTMLImageElement>();
TRASH_ITEMS.forEach(({ icon }) => {
  if (TRASH_IMG_CACHE.has(icon)) return;
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage2/${icon}`;
  TRASH_IMG_CACHE.set(icon, img);
});

// Thrower — viewed from behind; only the top half is ever drawn (the rest is
// cropped off, as if the character is standing behind the counter/foreground).
const THROWER_IMG = new Image();
THROWER_IMG.src = `${import.meta.env.BASE_URL}sprites/stage2/back.gif`;

// Garbage truck — slides across the screen once as Bonus Time's intro transition.
const TRUCK_IMG = new Image();
TRUCK_IMG.src = `${import.meta.env.BASE_URL}sprites/stage2/truck.gif`;

interface DecoyDef {
  icon: string; // stable identity key (not a sprite filename — decoys have multiple sprites, see below)
  idleImg: string; // held/queued preview's fallback, and the ambient cameo's "enter + hold" pose
  mirrorImg: string; // ambient cameo's pose while walking back out (mirror of idleImg)
  flyImg: string; // shown once actually thrown
  wheelchairImg: string; // shown in the wheelchair the instant anyone lands in it (correct or not)
  taxiImg: string; // shown in the taxi the instant anyone lands in it (correct or not)
  side: "left" | "right"; // ambient cameo always enters/exits from this fixed edge
  correctTarget: "taxi" | "wheelchair"; // which side target is the *correct* throw for this decoy
  label: string;
  penaltyMsg: string;
}
const DECOYS: DecoyDef[] = [
  {
    icon: "grandpa",
    idleImg: "grandpa-1.png",
    mirrorImg: "grandpa-1-mirror.png",
    flyImg: "grandpa-2.png",
    wheelchairImg: "wheelchair-grandpa.png",
    taxiImg: "taxi-grandpa.png",
    side: "left",
    correctTarget: "wheelchair", // 老人要送輪椅才對，丟到計程車反而扣分
    label: "迷路的老人家",
    penaltyMsg: "老人家：我還沒問完路啊！！",
  },
  {
    icon: "gf",
    idleImg: "gf-1.png",
    mirrorImg: "gf-1-mirror.png",
    flyImg: "gf-2.png",
    wheelchairImg: "wheelchair-GF.png",
    taxiImg: "taxi-gf.png",
    side: "right",
    correctTarget: "taxi", // 女友要送計程車才對，丟到輪椅扣分
    label: "查勤的女友",
    penaltyMsg: "啪！！女友：你居然想丟掉我？！",
  },
];
// Decoy sprites — preloaded up front, same pattern as TRASH_IMG_CACHE.
const DECOY_IMG_CACHE = new Map<string, HTMLImageElement>();
DECOYS.forEach(({ idleImg, mirrorImg, flyImg }) => {
  [idleImg, mirrorImg, flyImg].forEach((file) => {
    if (DECOY_IMG_CACHE.has(file)) return;
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}sprites/stage2/${file}`;
    DECOY_IMG_CACHE.set(file, img);
  });
});

// Chases the taxi/wheelchair off screen when it catches the wrong decoy —
// see the chase branch in drawSideTargets.
const POLICE_IMG = new Image();
POLICE_IMG.src = `${import.meta.env.BASE_URL}sprites/stage2/police.png`;

// ─── Ambient background cameo ───────────────────────────────────────────────
// Purely decorative — grandpa always walks on from the left, gf always from the
// right (def.side), during the throw phase. Not interactive, no score effect;
// just atmosphere behind the actual gameplay. Three phases: slide in (idleImg)
// → hold in place (idleImg) → slide back out the same edge (mirrorImg).
const BG_DECOY_ENTER_MS = 1200; // 老人／女友走進畫面的時間 — 數字越大，進場走得越久
// ▼▼▼ 老人／女友（連同計程車／輪椅，兩邊時機是綁在一起的）停留在畫面上的時間在這裡調整 ▼▼▼
// 數字越大，停留越久、玩家有越多時間丟中計程車／輪椅。
const BG_DECOY_HOLD_MS = 3200;
const BG_DECOY_EXIT_MS = 650; // 沒被丟中、自然走掉時的退場時間 — 數字越大，退場走得越久
const BG_DECOY_GAP_MIN_MS = 5000;
const BG_DECOY_GAP_MAX_MS = 10000;
// 背景客串圖片大小 — 比手上丟的誘餌圖更大一點，純裝飾用。
const BG_DECOY_SIZE = 170;

// ─── Side targets: 計程車／輪椅 ──────────────────────────────────────────────
// Replace the old "put down" button — whenever the ambient cameo swaps one of
// the held items into a decoy, these two slide in from opposite screen edges
// as the decoy's actual throw targets. Which one is *correct* depends on the
// specific decoy — see DecoyDef.correctTarget (老人要輪椅，女友要計程車).
// Falls back to an emoji + colored box if a sprite file is missing (same
// fallback pattern as drawSpriteImg).
// ▼▼▼ 計程車／輪椅的大小在這裡調整 ▼▼▼
const SIDE_TARGET_SIZE = 300; // 數字越大，計程車／輪椅圖片越大
const SIDE_TARGET_HIT_R = 46; // 判定「有丟中」的範圍半徑 — 通常配合 SIDE_TARGET_SIZE 一起調整
// ▼▼▼ 計程車／輪椅的進場幅度跟停留時間在這裡調整 ▼▼▼
// 進場／退場動畫時間 — 直接沿用老人／女友走進、走出畫面的時間
// （BG_DECOY_ENTER_MS／BG_DECOY_EXIT_MS），讓計程車／輪椅跟老人／女友
// 兩邊看起來是「同時」出現、同時移出畫面，改 BG_DECOY_* 這裡也會跟著變。
const SIDE_TARGET_ENTER_MS = BG_DECOY_ENTER_MS;
const SIDE_TARGET_EXIT_MS = BG_DECOY_EXIT_MS;
// ▼▼▼ 丟錯時，計程車／輪椅被 police 追逐的動畫在這裡調整 ▼▼▼
// 被丟中的計程車或輪椅反向逃到「另一邊」畫面外的時間 — 數字越大，追逐跑得越慢。
const SIDE_TARGET_CHASE_EXIT_MS = 2000;
// police.png 的大小，以及它跟被追的計程車／輪椅之間的距離
// （皆為 SIDE_TARGET_SIZE 的倍數）— 數字越大，police 越大／跟得越遠。
const SIDE_TARGET_CHASE_POLICE_SIZE_RATIO = 0.8;
const SIDE_TARGET_CHASE_GAP_RATIO = 0.95;
// 一丟中（不管丟對或丟錯）就會立刻觸發退場，不用等到老人／女友自然走掉；
// 沒丟中的話，退場時機改跟老人／女友的背景動畫綁在一起（見 update() 裡
// 「老人／女友開始走出畫面」那段），不再有自己獨立的逾時時間。
const SIDE_TARGET_IMG_CACHE = new Map<string, HTMLImageElement>();
(
  [
    "taxi.png",
    "wheelchair.png",
    // Shown instead of the plain taxi/wheelchair for a beat right after a
    // throw lands — the specific decoy sitting in it (see the taxi/wheelchair
    // hit branch in checkThrowLanding() and DecoyDef.taxiImg/wheelchairImg).
    "taxi-gf.png",
    "taxi-grandpa.png",
    "wheelchair-GF.png",
    "wheelchair-grandpa.png",
  ] as const
).forEach((file) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage2/${file}`;
  SIDE_TARGET_IMG_CACHE.set(file, img);
});

// ─── Bonus Time's catching net ──────────────────────────────────────────────
// Faces the direction it's currently moving — net_right.png while dragging
// right, net_left.png while dragging left (see GameState.netFacing).
const NET_IMG_CACHE = new Map<string, HTMLImageElement>();
(["net_left.png", "net_right.png"] as const).forEach((file) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage2/${file}`;
  NET_IMG_CACHE.set(file, img);
});

// ─── Web Audio SFX (synthesized — no audio assets) ──────────────────────────
let audioCtx: AudioContext | null = null;
const getAudioCtx = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
};

function playTone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  delay = 0,
) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ctx.destination);
  const t0 = ctx.currentTime + delay;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const playCorrect = () => {
  playTone(880, 0.1, "square", 0.12);
  playTone(1320, 0.12, "square", 0.1, 0.06);
};
const playWrong = () => playTone(220, 0.22, "sawtooth", 0.14);
const playCatch = () => playTone(1100, 0.06, "triangle", 0.1);

function playSlap() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * 0.12);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = 0.35;
  src.connect(g);
  g.connect(ctx.destination);
  src.start();
}

function playScream() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sawtooth";
  const t0 = ctx.currentTime;
  osc.frequency.setValueAtTime(1200, t0);
  osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.4);
  g.gain.setValueAtTime(0.22, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.5);
}

function playPenalty() {
  if (Math.random() < 0.5) playSlap();
  else playScream();
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate([40, 30, 90]);
    } catch {}
  }
}

// Warning siren — two up/down sweeps, played once when the "垃圾車即將來襲" window opens
function playAlarmSweep() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    const start = t0 + i * 0.5;
    osc.frequency.setValueAtTime(500, start);
    osc.frequency.linearRampToValueAtTime(1000, start + 0.22);
    osc.frequency.linearRampToValueAtTime(500, start + 0.44);
    g.gain.setValueAtTime(0.001, start);
    g.gain.linearRampToValueAtTime(0.12, start + 0.05);
    g.gain.linearRampToValueAtTime(0.001, start + 0.44);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.46);
  }
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    try {
      navigator.vibrate([80, 60, 80]);
    } catch {}
  }
}

const playCountdownBeep = () => playTone(900, 0.12, "square", 0.15);

// Truck horn — honks once right as Bonus Time's intro card appears
function playTruckHonk() {
  playTone(220, 0.25, "square", 0.16);
  playTone(180, 0.3, "square", 0.14, 0.15);
}

// Für Elise opening phrase — looped as the Bonus Time BGM cue
const FUR_ELISE = [
  659.25, 622.25, 659.25, 622.25, 659.25, 493.88, 587.33, 523.25, 440.0, 0,
  261.63, 329.63, 440.0, 493.88, 0, 329.63, 415.3, 493.88, 523.25,
];
let furEliseTimer: ReturnType<typeof setTimeout> | null = null;
function startFurElise() {
  stopFurElise();
  let i = 0;
  const step = () => {
    const freq = FUR_ELISE[i % FUR_ELISE.length];
    if (freq > 0) playTone(freq, 0.16, "triangle", 0.08);
    i++;
    furEliseTimer = setTimeout(step, 165);
  };
  step();
}
function stopFurElise() {
  if (furEliseTimer) {
    clearTimeout(furEliseTimer);
    furEliseTimer = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const rng = (min: number, max: number) => Math.random() * (max - min) + min;
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const shuffle = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);

// ─── Types ────────────────────────────────────────────────────────────────
interface FlyingItem {
  id: number;
  kind: "trash" | "decoy";
  category?: BinType;
  icon: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  bonus: boolean;
}

interface Popup {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
}

interface Bin {
  type: BinType;
  x: number;
  laneCx: number;
  flashUntil: number;
  flashGood: boolean;
  outFromX: number; // captured x when the reorder transition starts
  hitAt: number; // timestamp of the last item landing — drives the lid-open sprite swap
}

interface QueueItem {
  kind: "trash" | "decoy";
  category?: BinType;
  icon: string;
  label: string;
}

// The two new throw targets that replace the old "put down" button — appear
// together whenever a held slot is currently a decoy (see GameState.decoySwap).
interface SideTargets {
  taxiSide: "left" | "right"; // which edge the taxi enters from this time (wheelchair takes the other)
  enterAt: number;
  exitAt: number | null; // set once retracting; still drawn (animating out) until null
  flashUntil: number;
  flashGood: boolean;
  flashTarget: "taxi" | "wheelchair" | null; // which of the two was actually hit, for the flash above
  // Set the instant any decoy lands in the taxi/wheelchair (whether or not
  // that was the correct target for it) — swaps its empty sprite for the
  // "occupied" one (DecoyDef.taxiImg / wheelchairImg) until it retracts.
  taxiOccupantImg: string | null;
  wheelchairOccupantImg: string | null;
  // Set the instant a decoy is thrown into the WRONG target — that one (and
  // only that one) flees to the opposite edge chased by police.png instead
  // of retracting back out the near side (see the chase branch in
  // drawSideTargets). The other, uninvolved target still retracts normally.
  chasedTarget: "taxi" | "wheelchair" | null;
}

interface GameState {
  status: "idle" | "playing" | "gameover";
  phase: "throw" | "bonus";
  score: number;
  best: number;
  lastFrameTs: number;
  elapsed: number;
  bins: Bin[];
  binTransition: "idle" | "out" | "in";
  binTransitionStart: number;
  binReorderTriggered: boolean;
  flying: FlyingItem[];
  popups: Popup[];
  // Held items — BATCH_SIZE at a time, free pick; a slot goes null once thrown,
  // and the whole batch refills together once every slot is empty.
  queueBatch: (QueueItem | null)[];
  // Purely decorative background cameo (see BG_DECOY_* consts / drawBgDecoy) —
  // triggers decoySwap (below) when it appears, but otherwise unrelated to the
  // throw batch — just a grandpa/gf silhouette peeking in from a screen edge.
  // Once the throw resolves (hit, whether correct or wrong — see
  // resolveDecoySwap) it's dismissed instantly (gs.bgDecoy set straight to
  // null); exitAt is only used for the timed-out-untouched case, where it
  // still walks back out the side it entered from.
  bgDecoy: { def: DecoyDef; startedAt: number; exitAt: number | null } | null;
  bgDecoyNextAt: number;
  // Set while the ambient cameo has swapped one held slot into a decoy —
  // remembers the original item so it can be restored if never thrown.
  // Auto-reverts in lockstep with the ambient cameo's own exit (see update()),
  // so the taxi/wheelchair always retract at the same time it walks off.
  decoySwap: {
    slot: number;
    def: DecoyDef;
    originalItem: QueueItem;
    startedAt: number;
  } | null;
  sideTargets: SideTargets | null;
  aimSlot: number | null; // index into queueBatch currently being aimed, or null
  aimStart: { x: number; y: number } | null;
  aimCurrent: { x: number; y: number } | null;
  // Bonus Time's catching net — only present while the pointer is held down.
  netActive: boolean;
  netX: number;
  netY: number;
  netFacing: "left" | "right"; // which sprite (net_left/net_right.png) to draw
  shakeUntil: number;
  flashUntil: number;
  flashColor: string;
  idCounter: number;
  bonusAudioStarted: boolean;
  truckX: number;
  truckActive: boolean;
  bonusSpawnAt: number;
  bonusBannerUntil: number;
  bonusIntroUntil: number;
  lastPenaltyMsg: string | null;
  // Onboarding feedback — teach by nudging during play instead of relying on the idle-screen wall of text
  hasThrownOnce: boolean;
  decoyHintShownEver: boolean;
  decoyHintActive: boolean;
  decoyHintUntil: number;
  warningPlayed: boolean;
  warningBeepSecond: number;
  binReorderBeepSecond: number; // countdown beep tracker for the "bins about to reorder" warning
  hasCaughtOnce: boolean; // Bonus Time — whether the player has used the net yet
}

function spawnTrashItem(): QueueItem {
  const t = pick(TRASH_ITEMS);
  return { kind: "trash", category: t.category, icon: t.icon, label: t.label };
}

function spawnBatch(): QueueItem[] {
  return Array.from({ length: BATCH_SIZE }, () => spawnTrashItem());
}

// If every slot in the current batch has been thrown, refill all of them at
// once with a fresh batch of plain trash (decoys only ever appear via the
// ambient-cameo swap-in — see triggerDecoySwap — never from a normal refill).
function refillBatchIfEmpty(gs: GameState) {
  if (gs.queueBatch.every((slot) => slot === null)) {
    gs.queueBatch = spawnBatch();
  }
}

// Called the moment the ambient cameo (bgDecoy) appears — picks a random
// currently-held slot and temporarily turns it into that decoy, and slides in
// the taxi/wheelchair throw targets. If every slot is currently empty (rare —
// only right after the last item of a batch was just thrown) there's nothing
// to swap, so the cameo just walks past as pure decoration this time.
function triggerDecoySwap(gs: GameState, def: DecoyDef, now: number) {
  const eligible = gs.queueBatch
    .map((item, i) => ({ item, i }))
    .filter((s): s is { item: QueueItem; i: number } => s.item !== null);
  if (eligible.length === 0) return;
  const { item: originalItem, i: slot } = pick(eligible);
  gs.decoySwap = { slot, def, originalItem, startedAt: now };
  gs.queueBatch[slot] = { kind: "decoy", icon: def.icon, label: def.label };
  gs.sideTargets = {
    taxiSide: Math.random() < 0.5 ? "left" : "right",
    enterAt: now,
    exitAt: null,
    flashUntil: 0,
    flashGood: true,
    flashTarget: null,
    taxiOccupantImg: null,
    wheelchairOccupantImg: null,
    chasedTarget: null,
  };
  if (!gs.decoyHintShownEver) {
    gs.decoyHintShownEver = true;
    gs.decoyHintActive = true;
    gs.decoyHintUntil = now + DECOY_HINT_MS;
  }
}

// Immediately dismisses the ambient cameo (no exit animation) and arms the
// gap timer for the next one — used whenever the throw actually resolves
// (correct or wrong); only a timeout gets the gradual walk-out instead.
function dismissBgDecoyNow(gs: GameState, now: number) {
  gs.bgDecoy = null;
  gs.bgDecoyNextAt = now + rng(BG_DECOY_GAP_MIN_MS, BG_DECOY_GAP_MAX_MS);
}

type DecoyResolution = "correct" | "wrong" | "timeout";

// Resolves the current decoy swap — restores the slot's original item if it
// was never thrown (timeout only), and starts the side targets' retract
// (which target flees chased by police, if any, is set separately by the
// caller — see SideTargets.chasedTarget). The ambient cameo (grandpa/gf)
// itself just vanishes instantly on any resolved throw, correct or wrong;
// only a timeout (never thrown) gets its normal walk-out-the-way-it-came.
function resolveDecoySwap(
  gs: GameState,
  now: number,
  outcome: DecoyResolution,
) {
  if (
    outcome === "timeout" &&
    gs.decoySwap &&
    gs.queueBatch[gs.decoySwap.slot]?.kind === "decoy"
  ) {
    gs.queueBatch[gs.decoySwap.slot] = gs.decoySwap.originalItem;
  }
  gs.decoySwap = null;
  gs.decoyHintActive = false;
  if (gs.sideTargets) gs.sideTargets.exitAt = now;

  if (gs.bgDecoy && gs.bgDecoy.exitAt === null) {
    if (outcome === "timeout") gs.bgDecoy.exitAt = now;
    else dismissBgDecoyNow(gs, now);
  }
}

function makeBins(): Bin[] {
  // Clustered closer to center than before — no more drift/sway, so there's
  // no need for wide lanes to keep them from visually colliding mid-motion.
  // 三個垃圾桶的水平位置（0~1 為畫面寬度比例，0.5 是正中間）
  // 數字越靠近 0.5 代表垃圾桶越集中；目前為 0.4 / 0.55 / 0.7。
  const lanes = [LW * 0.28, LW * 0.5, LW * 0.72];
  const shuffled = [...BIN_TYPES].sort(() => Math.random() - 0.5);
  return shuffled.map((type, i) => ({
    type,
    x: lanes[i],
    laneCx: lanes[i],
    flashUntil: 0,
    flashGood: true,
    outFromX: lanes[i],
    hitAt: -Infinity,
  }));
}

function initState(best: number): GameState {
  return {
    status: "idle",
    phase: "throw",
    score: 0,
    best,
    lastFrameTs: 0,
    elapsed: 0,
    bins: makeBins(),
    binTransition: "idle",
    binTransitionStart: 0,
    binReorderTriggered: false,
    flying: [],
    popups: [],
    // First batch is always plain trash — decoys only ever appear via the
    // ambient cameo swap-in, never at game start.
    queueBatch: spawnBatch(),
    bgDecoy: null,
    // First cameo appears a few seconds in rather than instantly on game start.
    bgDecoyNextAt: performance.now() + rng(2000, 5000),
    decoySwap: null,
    sideTargets: null,
    aimSlot: null,
    aimStart: null,
    aimCurrent: null,
    netActive: false,
    netX: LW / 2,
    netY: LH / 2,
    netFacing: "right",
    shakeUntil: 0,
    flashUntil: 0,
    flashColor: "#ff3030",
    idCounter: 1,
    bonusAudioStarted: false,
    truckX: -160,
    truckActive: false,
    bonusSpawnAt: 0,
    bonusBannerUntil: 0,
    bonusIntroUntil: 0,
    lastPenaltyMsg: null,
    hasThrownOnce: false,
    hasCaughtOnce: false,
    decoyHintShownEver: false,
    decoyHintActive: false,
    decoyHintUntil: 0,
    warningPlayed: false,
    warningBeepSecond: 0,
    binReorderBeepSecond: 0,
  };
}

// 控制角色（丟東西的那隻）的高度 — 只會畫出圖片上半部，且畫面上固定貼齊螢幕最底部。
const THROWER_FULL_H = 128;
// 手上拿著的垃圾／丟出去那一瞬間的起始高度 — 固定在角色頭頂上方一點的位置。
const THROWER_ITEM_Y = () => LH - THROWER_FULL_H / 2 - 14;
// x position of held-batch slot i (0..BATCH_SIZE-1), centered on the thrower.
const batchSlotX = (i: number) =>
  LW / 2 + (i - (BATCH_SIZE - 1) / 2) * BATCH_SLOT_GAP;
// 角色目前實際畫出來的寬度（依圖片比例換算）— 力度 bar／放下按鈕都靠這個數字貼在角色兩側。
const throwerDrawW = () =>
  THROWER_IMG.complete && THROWER_IMG.naturalWidth > 0
    ? (THROWER_FULL_H * THROWER_IMG.naturalWidth) / THROWER_IMG.naturalHeight
    : THROWER_FULL_H;
// ▼▼▼ 垃圾桶位置在這裡調整 ▼▼▼
// 垃圾桶「開口」的高度 — 數字越大（0~1，相對畫面高度）垃圾桶整體越往下移。
const BIN_OPEN_Y = () => LH * 0.29;
// 垃圾桶圖片實際畫出來的寬高（跟 drawBins 畫的大小一致）。垃圾桶圖片本身
// 比 BIN_H 高很多，先前碰撞判定只算到 BIN_H 那麼高，導致垃圾桶下半部丟不中；
// 這裡改成直接用圖片實際高度，讓碰撞範圍涵蓋整個垃圾桶。
const BIN_DRAW_W = 100;
const binDrawH = (): number => {
  const img = BIN_IMG_CACHE.get(`${BIN_COLOR.general}-1`);
  return img && img.naturalWidth > 0
    ? Math.round((BIN_DRAW_W * img.naturalHeight) / img.naturalWidth)
    : BIN_H + 16;
};
// ▼▼▼ 計程車／輪椅滑進畫面的位置在這裡調整 ▼▼▼
// 計程車／輪椅跟螢幕邊緣的距離（像素）— 數字越小，貼螢幕邊邊貼越緊；
// 0 就是圖片邊緣剛好碰到螢幕邊界，可依需要再加大留一點空隙。
const SIDE_TARGET_EDGE_GAP = -100;
// 計程車／輪椅「停下來」的最終位置 — 固定貼齊左右邊緣（跟畫面寬度無關，兩種螢幕比例都一樣貼邊）。
const sideTargetRestX = (side: "left" | "right") =>
  side === "left"
    ? SIDE_TARGET_SIZE / 2 + SIDE_TARGET_EDGE_GAP
    : LW - SIDE_TARGET_SIZE / 2 - SIDE_TARGET_EDGE_GAP;
// 計程車／輪椅一開始「藏起來」的位置 — 完全躲到畫面外（圖片整個看不見），
// 這樣滑動時才會像「從畫面邊邊冒出來」，而不是憑空出現／消失。
const sideTargetOffX = (side: "left" | "right") =>
  side === "left" ? -SIDE_TARGET_SIZE / 2 : LW + SIDE_TARGET_SIZE / 2;
// 計程車／輪椅的垂直位置 — 數字越大，位置越往下移動。
const SIDE_TARGET_Y_OFFSET = 130;
const sideTargetY = () => BIN_OPEN_Y() + BIN_H / 2 + SIDE_TARGET_Y_OFFSET;
// Full physical canvas width expressed in logical units — LW alone can be
// narrower than this in landscape (where GS is height-bound), leaving
// letterbox strips on the sides that full-bleed fills need to cover too.
const fullLW = () => CW / GS;

function addPopup(
  gs: GameState,
  x: number,
  y: number,
  text: string,
  color: string,
) {
  gs.popups.push({
    id: gs.idCounter++,
    x,
    y,
    text,
    color,
    born: performance.now(),
  });
}

// Checks whether a non-bonus flying item is currently overlapping a side
// target (taxi/wheelchair) or a bin, and resolves the hit (score, sound,
// popup, bin/side-target flash) if so. Doesn't remove `it` from gs.flying —
// the caller does that based on the return value. Called once per sub-step
// (see BIN_COLLISION_SUBSTEPS) so fast throws can't tunnel through a target.
function checkThrowLanding(
  gs: GameState,
  it: FlyingItem,
  now: number,
): boolean {
  // Side targets (計程車／輪椅) — only relevant to a decoy while it's live
  // (see triggerDecoySwap / SideTargets). Uses its own Y position (sideTargetY)
  // and a circular hit radius, independent of the bins' Y band below — their
  // vertical position can be tuned separately (see SIDE_TARGET_Y_OFFSET).
  // Which one is *correct* depends on the specific decoy (DecoyDef.correctTarget)
  // — grandpa wants the wheelchair, gf wants the taxi.
  if (it.kind === "decoy" && gs.sideTargets && gs.sideTargets.exitAt === null) {
    const def = DECOYS.find((d) => d.icon === it.icon);
    const ty = sideTargetY();
    const taxiX = sideTargetRestX(gs.sideTargets.taxiSide);
    const wheelchairX = sideTargetRestX(
      gs.sideTargets.taxiSide === "left" ? "right" : "left",
    );
    const hitTaxi = Math.hypot(it.x - taxiX, it.y - ty) <= SIDE_TARGET_HIT_R;
    const hitWheelchair =
      !hitTaxi &&
      Math.hypot(it.x - wheelchairX, it.y - ty) <= SIDE_TARGET_HIT_R;
    if (hitTaxi || hitWheelchair) {
      const hitTarget: "taxi" | "wheelchair" = hitTaxi ? "taxi" : "wheelchair";
      const isCorrect = def?.correctTarget === hitTarget;
      gs.sideTargets.flashUntil = now + 260;
      gs.sideTargets.flashGood = isCorrect;
      gs.sideTargets.flashTarget = hitTarget;
      if (hitTarget === "wheelchair") {
        gs.sideTargets.wheelchairOccupantImg = def?.wheelchairImg ?? null;
      } else {
        gs.sideTargets.taxiOccupantImg = def?.taxiImg ?? null;
      }
      if (isCorrect) {
        gs.score += SCORE_DECOY_CORRECT;
        addPopup(gs, it.x, it.y, `+${SCORE_DECOY_CORRECT}`, "#4ade80");
        playCorrect();
      } else {
        gs.score += SCORE_DECOY_PENALTY;
        gs.shakeUntil = now + 320;
        gs.flashUntil = now + 220;
        gs.flashColor = "#ff2020";
        gs.lastPenaltyMsg = def?.penaltyMsg ?? "慘叫！！";
        addPopup(gs, it.x, it.y, `${SCORE_DECOY_PENALTY}`, "#ff4040");
        playPenalty();
        // Wrong target — that one flees chased by police.png instead of
        // retracting normally (see the chase branch in drawSideTargets).
        gs.sideTargets.chasedTarget = hitTarget;
      }
      resolveDecoySwap(gs, now, isCorrect ? "correct" : "wrong");
      return true;
    }
  }

  // Bin-landing check — the whole bin counts, not just a narrow strip down its
  // center. Y band now matches the bin sprite's actual drawn height (see
  // binDrawH/drawBins) instead of the much-shorter BIN_H, so throws landing
  // near the bottom of the bin register too.
  const binTop = BIN_OPEN_Y() - 6;
  if (it.y < binTop || it.y > binTop + binDrawH()) return false;
  const hitBin = gs.bins.find((b) => Math.abs(b.x - it.x) <= BIN_W / 2);
  if (hitBin) {
    hitBin.flashUntil = now + 260;
    hitBin.hitAt = now;
    if (it.kind === "decoy") {
      gs.score += SCORE_DECOY_PENALTY;
      hitBin.flashGood = false;
      gs.shakeUntil = now + 320;
      gs.flashUntil = now + 220;
      gs.flashColor = "#ff2020";
      const decoy = DECOYS.find((d) => d.icon === it.icon);
      gs.lastPenaltyMsg = decoy?.penaltyMsg ?? "慘叫！！";
      addPopup(gs, it.x, it.y, `${SCORE_DECOY_PENALTY}`, "#ff4040");
      playPenalty();
      resolveDecoySwap(gs, now, "wrong");
    } else if (it.category === hitBin.type) {
      gs.score += SCORE_CORRECT;
      hitBin.flashGood = true;
      addPopup(gs, it.x, it.y, `+${SCORE_CORRECT}`, "#4ade80");
      playCorrect();
    } else {
      gs.score += SCORE_WRONG_BIN;
      hitBin.flashGood = false;
      addPopup(gs, it.x, it.y, `${SCORE_WRONG_BIN}`, "#f0a020");
      playWrong();
    }
    return true;
  }
  return false;
}

// ─── Update ───────────────────────────────────────────────────────────────
function update(gs: GameState, now: number, dtMs: number) {
  const dt = dtMs / 1000;
  gs.elapsed += dtMs;

  // Warning window — the last few seconds before Bonus Time get louder instead of
  // cutting over instantly, so the switch doesn't blindside the player.
  if (gs.phase === "throw") {
    const timeToBonus = THROW_PHASE_MS - gs.elapsed;
    if (timeToBonus > 0 && timeToBonus <= BONUS_WARNING_MS) {
      if (!gs.warningPlayed) {
        gs.warningPlayed = true;
        playAlarmSweep();
      }
      const sec = Math.ceil(timeToBonus / 1000);
      if (sec <= 3 && sec !== gs.warningBeepSecond) {
        gs.warningBeepSecond = sec;
        playCountdownBeep();
      }
    }

    // Small countdown beep before the bins reorder, same idea as the Bonus Time warning
    const timeToReorder = BIN_REORDER_AT_MS - gs.elapsed;
    if (
      !gs.binReorderTriggered &&
      timeToReorder > 0 &&
      timeToReorder <= BIN_REORDER_WARNING_MS
    ) {
      const sec = Math.ceil(timeToReorder / 1000);
      if (sec <= 3 && sec !== gs.binReorderBeepSecond) {
        gs.binReorderBeepSecond = sec;
        playCountdownBeep();
      }
    }
  }

  // Phase transition → Bonus Time (with a brief title-card beat before items start spawning)
  if (gs.phase === "throw" && gs.elapsed >= THROW_PHASE_MS) {
    gs.phase = "bonus";
    gs.flying = gs.flying.filter((f) => f.bonus);
    gs.aimSlot = null;
    gs.aimStart = null;
    gs.aimCurrent = null;
    gs.truckActive = true;
    // 車頭朝左，所以改成從右邊開進來、往左邊開走——車身完全藏到畫面右邊外面才開始滑入
    // （大小改變時這裡會自動跟著算）
    gs.truckX = LW + truckDrawW() / 2 + 40;
    gs.bonusIntroUntil = now + BONUS_INTRO_MS;
    gs.bonusSpawnAt = gs.bonusIntroUntil + 250;
    gs.bonusBannerUntil = now + BONUS_BANNER_MS;
    playTruckHonk();
    stopGame2Bgm(); // Bonus Time has its own Für Elise cue — avoid overlapping BGM
    if (!gs.bonusAudioStarted) {
      gs.bonusAudioStarted = true;
      startFurElise();
    }
  }

  if (gs.elapsed >= TOTAL_MS) {
    gs.status = "gameover";
    gs.phase = "throw";
    stopFurElise();
    stopGame2Bgm();
    addRecord(2, gs.score);
    if (gs.score > gs.best) gs.best = gs.score;
    return;
  }

  // Bins sit still except for a single reorder shuffle at BIN_REORDER_AT_MS —
  // no more idle drift or continuous side-to-side sway.
  if (gs.phase === "throw") {
    if (gs.elapsed >= BIN_REORDER_AT_MS && !gs.binReorderTriggered) {
      gs.binReorderTriggered = true;
      gs.binTransition = "out";
      gs.binTransitionStart = now;
      for (const bin of gs.bins) bin.outFromX = bin.x;
    }
    if (gs.binTransition === "out") {
      const p = Math.min(1, (now - gs.binTransitionStart) / BIN_TRANSITION_MS);
      const eased = p * p;
      for (const bin of gs.bins)
        bin.x = bin.outFromX + (LW + 140 - bin.outFromX) * eased;
      if (p >= 1) {
        const types = shuffle(BIN_TYPES);
        gs.bins.forEach((bin, i) => {
          bin.type = types[i];
          bin.x = -140;
        });
        gs.binTransition = "in";
        gs.binTransitionStart = now;
      }
    } else if (gs.binTransition === "in") {
      const p = Math.min(1, (now - gs.binTransitionStart) / BIN_TRANSITION_MS);
      const eased = 1 - (1 - p) * (1 - p);
      for (const bin of gs.bins) bin.x = -140 + (bin.laneCx + 140) * eased;
      if (p >= 1) {
        gs.binTransition = "idle";
        for (const bin of gs.bins) bin.x = bin.laneCx;
      }
    }
  }

  // Garbage truck intro slide — drives right-to-left (its cab faces left in the
  // artwork) and only deactivates (which also opens the gate for Bonus Time
  // items to start spawning) once its own right edge has fully cleared the
  // left side of the screen, whatever size it's drawn at.
  if (gs.truckActive) {
    gs.truckX -= dt * TRUCK_SPEED; // 垃圾車進場速度在這裡調整（數字越大開得越快）
    if (gs.truckX + truckDrawW() / 2 < -40) gs.truckActive = false;
  }

  // Bonus spawns — wait for the truck to fully drive off-screen before anything appears
  if (gs.phase === "bonus" && !gs.truckActive && now >= gs.bonusSpawnAt) {
    gs.bonusSpawnAt = now + rng(BONUS_SPAWN_MIN_MS, BONUS_SPAWN_MAX_MS);
    const t = pick(TRASH_ITEMS);
    const fromLeft = Math.random() < 0.5;
    gs.flying.push({
      id: gs.idCounter++,
      kind: "trash",
      category: t.category,
      icon: t.icon,
      label: t.label,
      x: fromLeft ? -20 : LW + 20,
      y: LH + 20,
      vx: fromLeft ? rng(90, 170) : -rng(90, 170),
      vy: -rng(480, 620),
      rot: 0,
      vrot: rng(-6, 6),
      bonus: true,
    });
  }

  // Flying items physics
  for (let i = gs.flying.length - 1; i >= 0; i--) {
    const it = gs.flying[i];
    if (it.bonus) {
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.vy += GRAVITY * dt; // straight-line throws ignore gravity; only Bonus Time arcs
      it.rot += it.vrot * dt;
    } else {
      // Straight-line throws move in BIN_COLLISION_SUBSTEPS small hops instead
      // of one big jump — a fast throw can easily cover more than a bin's
      // width in a single frame, which let it fly straight through without
      // ever landing exactly on a bin/side-target during the one frame checked.
      const subDt = dt / BIN_COLLISION_SUBSTEPS;
      let hit = false;
      for (let s = 0; s < BIN_COLLISION_SUBSTEPS; s++) {
        it.x += it.vx * subDt;
        it.y += it.vy * subDt;
        if (checkThrowLanding(gs, it, now)) {
          hit = true;
          break;
        }
      }
      it.rot += it.vrot * dt;
      if (hit) {
        gs.flying.splice(i, 1);
        continue;
      }
    }

    // Off-screen cleanup (straight-line misses fly off the top with no gravity to bring them back)
    if (it.y > LH + 60 || it.y < -60 || it.x < -80 || it.x > LW + 80) {
      gs.flying.splice(i, 1);
    }
  }

  // Decoy tooltip times out if the player just sits on it without acting
  if (gs.decoyHintActive && now > gs.decoyHintUntil) gs.decoyHintActive = false;

  // Ambient background cameo — also kicks off the decoy swap-in (see triggerDecoySwap).
  // The taxi/wheelchair (and vice versa) retract in lockstep with it — see
  // resolveDecoySwap, which sets bgDecoy.exitAt the instant either side
  // resolves, instead of each running on its own independent timer.
  if (gs.phase === "throw") {
    if (gs.bgDecoy) {
      const exitStart =
        gs.bgDecoy.exitAt ??
        gs.bgDecoy.startedAt + BG_DECOY_ENTER_MS + BG_DECOY_HOLD_MS;
      if (now - exitStart > BG_DECOY_EXIT_MS) dismissBgDecoyNow(gs, now);
    } else if (now >= gs.bgDecoyNextAt) {
      const def = pick(DECOYS);
      gs.bgDecoy = { def, startedAt: now, exitAt: null };
      triggerDecoySwap(gs, def, now);
    }
  }

  // Still holding a decoy once the ambient cameo itself starts walking back
  // out on its own natural schedule (never got thrown in time) — restore the
  // original item and start the side targets' retract right now, so
  // everything exits together.
  if (
    gs.decoySwap &&
    gs.bgDecoy &&
    gs.bgDecoy.exitAt === null &&
    now - gs.bgDecoy.startedAt >= BG_DECOY_ENTER_MS + BG_DECOY_HOLD_MS
  ) {
    resolveDecoySwap(gs, now, "timeout");
  }

  // Side targets fully retract a moment after they start exiting, then are
  // cleared — waits the longer chase duration if one of them is being
  // chased off by police (see SideTargets.chasedTarget).
  if (gs.sideTargets && gs.sideTargets.exitAt !== null) {
    const exitDur = gs.sideTargets.chasedTarget
      ? SIDE_TARGET_CHASE_EXIT_MS
      : SIDE_TARGET_EXIT_MS;
    if (now - gs.sideTargets.exitAt > exitDur) gs.sideTargets = null;
  }

  // Popups aging
  gs.popups = gs.popups.filter((p) => now - p.born < 900);

  // Net catching (Bonus Time) — runs every frame the net is held down, so an
  // item falling into a stationary net still gets caught even without the
  // pointer itself moving.
  if (gs.phase === "bonus" && gs.netActive) {
    for (let i = gs.flying.length - 1; i >= 0; i--) {
      const it = gs.flying[i];
      if (!it.bonus) continue;
      if (Math.hypot(it.x - gs.netX, it.y - gs.netY) < NET_CATCH_R) {
        gs.score += SCORE_CATCH;
        addPopup(gs, it.x, it.y, `+${SCORE_CATCH}`, "#f0c040");
        playCatch();
        gs.flying.splice(i, 1);
      }
    }
  }
}

// ─── Drawing ────────────────────────────────────────────────────────────────
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

const EMOJI_FONT = (size: number) =>
  `${size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;

// Draws one or more lines of white text inside a HUD-panel-style framed box
// (dark navy fill + blue border + drop shadow — matches the SCORE/TIME DOM
// panel look) centered at (x, y). Used for the various canvas warning/hint
// banners so they read consistently with the rest of the HUD.
function drawFramedLines(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  lines: string[],
  fontSize: number,
  options?: { textColor?: string; borderColor?: string },
) {
  const textColor = options?.textColor ?? "#fff";
  const borderColor = options?.borderColor ?? "#1e3a6e";

  ctx.font = `bold ${fontSize}px "Cubic11", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = 14;
  const padY = 8;
  const lineGap = fontSize * 1.25;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textW + padX * 2;
  const boxH = lines.length * lineGap + padY * 2 - (lineGap - fontSize);
  const top = y - boxH / 2;
  const left = x - boxW / 2;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "rgba(5,15,40,0.92)";
  drawRoundRect(ctx, left, top, boxW, boxH, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  drawRoundRect(ctx, left, top, boxW, boxH, 8);
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 3;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, top + padY + fontSize / 2 + i * lineGap);
  });
  ctx.restore();
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  phase: "throw" | "bonus",
) {
  // The scene art is a looping <video> behind the canvas (same setup as
  // GameCanvas) — just clear so it shows through, and tint darker in Bonus
  // Time so the truck-attack switch still reads as a different mood.
  ctx.clearRect(0, 0, fullLW(), LH);
  if (phase === "bonus") {
    ctx.fillStyle = "rgba(40,24,8,0.35)";
    ctx.fillRect(0, 0, fullLW(), LH);
  }
}

// Which lid-frame a bin should show right now — trash landing kicks it from
// the idle frame (1) through "opening" (2) and "open" (3) before it resets.
function binFrame(bin: Bin, now: number): 1 | 2 | 3 {
  const t = now - bin.hitAt;
  if (t < BIN_OPEN_FRAME2_MS) return 2;
  if (t < BIN_OPEN_FRAME2_MS + BIN_OPEN_FRAME3_MS) return 3;
  return 1;
}

// While the player is aiming a throw, predict which bin the straight-line
// trajectory currently lines up with (same math as launch()) and pop its lid
// open right away instead of waiting for the item to actually land.
function predictedTargetBin(gs: GameState): Bin | null {
  if (gs.aimSlot === null || !gs.aimStart || !gs.aimCurrent) return null;
  const dx = gs.aimCurrent.x - gs.aimStart.x;
  const dy = gs.aimCurrent.y - gs.aimStart.y;
  if (Math.hypot(dx, dy) < MIN_DRAG_DIST || dy > -MIN_DRAG_DIST * 0.5)
    return null;
  let vx = dx * DRAG_K,
    vy = dy * DRAG_K;
  const speed = Math.hypot(vx, vy);
  if (speed > MAX_LAUNCH_SPEED) {
    vx *= MAX_LAUNCH_SPEED / speed;
    vy *= MAX_LAUNCH_SPEED / speed;
  }
  const t = (BIN_OPEN_Y() - THROWER_ITEM_Y()) / vy;
  const predictedX = LW / 2 + vx * t;
  let closest: Bin | null = null;
  let bestDist = Infinity;
  for (const bin of gs.bins) {
    const d = Math.abs(bin.x - predictedX);
    if (d < bestDist) {
      bestDist = d;
      closest = bin;
    }
  }
  // 監測範圍改用「垃圾桶排列間距的一半」（對應 makeBins 的 0.28／0.5／0.72
  // 車道位置，間距 0.22 * LW）—— 瞄準畫面中間時，預測位置一定會落在離它最近
  // 的那個垃圾桶的這個範圍內（不會被旁邊的桶搶走），但又不會像用垃圾桶本身
  // 寬度那樣窄到手一滑就整個不預覽；只有預測位置真的超出最左/右垃圾桶太遠
  // （瞄得太歪）才不會預先開蓋。
  const laneHalfGap = LW * 0.11;
  return bestDist <= laneHalfGap ? closest : null;
}

function drawBins(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  const predicted = predictedTargetBin(gs);
  for (const bin of gs.bins) {
    const frame = bin === predicted ? 3 : binFrame(bin, now);
    const img = BIN_IMG_CACHE.get(`${BIN_COLOR[bin.type]}-${frame}`);
    const flashing = now < bin.flashUntil;

    const drawW = BIN_DRAW_W;
    const drawH = binDrawH();
    const x = bin.x - drawW / 2;
    const y = BIN_OPEN_Y() - 6;

    ctx.save();
    if (flashing) {
      ctx.shadowColor = bin.flashGood ? "#4ade80" : "#ff3030";
      ctx.shadowBlur = 22;
    }
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x, y, drawW, drawH);
      if (flashing) ctx.drawImage(img, x, y, drawW, drawH); // second pass makes the glow read clearly
    } else {
      ctx.fillStyle = BIN_DEFS[bin.type].color;
      drawRoundRect(ctx, x, y + 10, drawW, drawH - 10, 10);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Draws a sprite centered at (0,0), scaled to fit within maxSize while
// preserving its natural aspect ratio (sprites aren't all square).
function drawSpriteImg(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | undefined,
  maxSize: number,
) {
  if (img && img.complete && img.naturalWidth > 0) {
    const ratio = img.naturalWidth / img.naturalHeight;
    const dw = ratio > 1 ? maxSize : maxSize * ratio;
    const dh = ratio > 1 ? maxSize / ratio : maxSize;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else {
    ctx.fillStyle = "#888";
    drawRoundRect(ctx, -maxSize / 2, -maxSize / 2, maxSize, maxSize, 6);
    ctx.fill();
  }
}

function drawTrashSprite(
  ctx: CanvasRenderingContext2D,
  key: string,
  maxSize: number,
) {
  drawSpriteImg(ctx, TRASH_IMG_CACHE.get(key), maxSize);
}

// ▼▼▼ 丟出去的物品大小在這裡調整 ▼▼▼
// 一般丟出的垃圾／垃圾車小遊戲的垃圾／丟出的誘餌（老人、女友）— 數字越大物品越大。
// 目前都是先前尺寸再放大 10%。
const FLYING_TRASH_SIZE = 48;
const FLYING_TRASH_BONUS_SIZE = 59;
const FLYING_DECOY_SIZE = 79;

function drawFlyingItem(ctx: CanvasRenderingContext2D, it: FlyingItem) {
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.rotate(it.rot);
  if (it.kind === "decoy") {
    ctx.shadowColor = "rgba(255,60,60,0.55)";
    ctx.shadowBlur = 16;
    const def = DECOYS.find((d) => d.icon === it.icon);
    drawSpriteImg(
      ctx,
      def && DECOY_IMG_CACHE.get(def.flyImg),
      FLYING_DECOY_SIZE,
    );
  } else {
    if (it.bonus) {
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 6;
    }
    drawTrashSprite(
      ctx,
      it.icon,
      it.bonus ? FLYING_TRASH_BONUS_SIZE : FLYING_TRASH_SIZE,
    );
  }
  ctx.restore();
}

// Purely decorative background cameo — grandpa always walks on from the left,
// gf always from the right (def.side). Not interactive, no hit-testing, just
// atmosphere; drawn behind the gameplay elements in render(). Three phases:
// slide in from off-screen (idleImg) → hold in place (idleImg) → slide back
// out the same edge (mirrorImg, since it's now facing/walking the other way).
function drawBgDecoy(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  if (!gs.bgDecoy) return;
  const { def, startedAt, exitAt } = gs.bgDecoy;
  const age = now - startedAt;
  const y = LH * 0.4;
  const offX =
    def.side === "right" ? LW + BG_DECOY_SIZE * 0.6 : -BG_DECOY_SIZE * 0.6;
  const restX =
    def.side === "right" ? LW - BG_DECOY_SIZE * 0.42 : BG_DECOY_SIZE * 0.42;

  let x: number;
  let imgFile: string;
  if (exitAt !== null) {
    // Retracting on its own natural schedule (never got thrown in time) —
    // walk back out the same side it entered from.
    const t = Math.min(1, (now - exitAt) / BG_DECOY_EXIT_MS);
    const eased = t * t;
    x = restX + (offX - restX) * eased;
    imgFile = def.mirrorImg;
  } else if (age < BG_DECOY_ENTER_MS) {
    const t = age / BG_DECOY_ENTER_MS;
    const eased = 1 - (1 - t) * (1 - t);
    x = offX + (restX - offX) * eased;
    imgFile = def.idleImg;
  } else if (age < BG_DECOY_ENTER_MS + BG_DECOY_HOLD_MS) {
    x = restX;
    imgFile = def.idleImg;
  } else {
    const t = Math.min(
      1,
      (age - BG_DECOY_ENTER_MS - BG_DECOY_HOLD_MS) / BG_DECOY_EXIT_MS,
    );
    const eased = t * t;
    x = restX + (offX - restX) * eased;
    imgFile = def.mirrorImg;
  }

  ctx.save();
  ctx.translate(x, y);
  drawSpriteImg(ctx, DECOY_IMG_CACHE.get(imgFile), BG_DECOY_SIZE);
  ctx.restore();
}

// No trajectory preview — just a power bar so the player feels how hard they're pulling.
// Sits right beside the character (on its left) instead of pinned to the
// screen edge, and uses an opaque panel + bright border so it doesn't get
// lost against the busy background video.
function drawPowerBar(ctx: CanvasRenderingContext2D, gs: GameState) {
  if (gs.aimSlot === null || !gs.aimStart || !gs.aimCurrent) return;
  const dx = gs.aimCurrent.x - gs.aimStart.x;
  const dy = gs.aimCurrent.y - gs.aimStart.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 6) return;
  const validDir = dy < -MIN_DRAG_DIST * 0.5;
  const maxDist = MAX_LAUNCH_SPEED / DRAG_K;
  const ratio = Math.max(0, Math.min(1, dist / maxDist));

  const barW = 18,
    barH = 140;
  const barX = LW / 2 - throwerDrawW() / 2 - barW - 14;
  const barBottom = LH - 8;
  const barTop = barBottom - barH;

  ctx.save();
  // Opaque HUD-panel-style backing (matches the SCORE/TIME panels) instead of
  // a faint translucent black box, so it reads clearly against any background.
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = "rgba(5,15,40,0.92)";
  drawRoundRect(ctx, barX, barTop, barW, barH, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = validDir ? "#60a5fa" : "#ff5050";
  ctx.lineWidth = 3;
  drawRoundRect(ctx, barX, barTop, barW, barH, 8);
  ctx.stroke();

  const fillH = Math.max(0, barH * ratio - 4);
  if (fillH > 0) {
    const grad = ctx.createLinearGradient(0, barBottom, 0, barTop);
    grad.addColorStop(0, "#22e07a");
    grad.addColorStop(0.6, "#ffd23f");
    grad.addColorStop(1, "#ff3030");
    ctx.fillStyle = validDir ? grad : "rgba(255,80,80,0.7)";
    drawRoundRect(ctx, barX + 3, barBottom - 3 - fillH, barW - 6, fillH, 6);
    ctx.fill();
  }

  ctx.font = 'bold 12px "Cubic11", sans-serif';
  ctx.fillStyle = validDir ? "#fff" : "#ffb0b0";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.7)";
  ctx.shadowBlur = 4;
  ctx.fillText(validDir ? "力道" : "↑ 需向上", barX + barW / 2, barTop - 12);
  ctx.restore();
}

// Thrower body — only the top half of the sprite is ever drawn (the source
// rect stops at naturalHeight/2), as if the character stands behind the counter.
// The body itself stays still and sits flush with the very bottom of the
// screen; `bob` is only applied to the held-item float above it.
function drawThrower(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  const cx = LW / 2;
  const bob = Math.sin(now / 260) * 4;

  const img = THROWER_IMG;
  if (img.complete && img.naturalWidth > 0) {
    const drawW = (THROWER_FULL_H * img.naturalWidth) / img.naturalHeight;
    const halfDrawH = THROWER_FULL_H / 2;
    const halfSrcH = img.naturalHeight / 2;
    const bottomY = LH; // 貼齊畫面最底部
    ctx.drawImage(
      img,
      0,
      0,
      img.naturalWidth,
      halfSrcH,
      cx - drawW / 2,
      bottomY - halfDrawH,
      drawW,
      halfDrawH,
    );
  }
  // The 3 held slots — free-pick, so all non-empty slots stay visible at
  // once. The slot currently being aimed follows the pointer instead of
  // disappearing, like pulling it back on a slingshot.
  gs.queueBatch.forEach((item, i) => {
    if (!item) return;
    const isAiming = gs.aimSlot === i && gs.aimCurrent;
    const px = isAiming ? gs.aimCurrent!.x : batchSlotX(i);
    const py = isAiming ? gs.aimCurrent!.y : THROWER_ITEM_Y() + bob;
    ctx.save();
    if (item.kind === "decoy") {
      // The interactive decoy (held here, then thrown) always uses its "-2"
      // (already-mid-flail) sprite — the "-1" pose is reserved for the purely
      // decorative background cameo (see drawBgDecoy), not this held preview.
      ctx.shadowColor = "rgba(255,60,60,0.65)";
      ctx.shadowBlur = 18;
      const def = DECOYS.find((d) => d.icon === item.icon);
      ctx.translate(px, py);
      drawSpriteImg(
        ctx,
        def && DECOY_IMG_CACHE.get(def.flyImg),
        BATCH_DECOY_SIZE,
      );
    } else {
      ctx.translate(px, py);
      drawTrashSprite(ctx, item.icon, BATCH_ITEM_SIZE);
    }
    ctx.restore();
  });
}

// Nudges the player to swipe, until they land their first throw — most people skip the idle-screen text.
// Sits above the character's head (which is now flush with the bottom of the
// screen); disappears the moment the player touches down to aim (gs.aimSlot),
// i.e. right as they start swiping, not just after a completed throw.
function drawSwipeHint(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  if (gs.hasThrownOnce || gs.aimSlot !== null) return;
  const cx = LW / 2;
  const headTopY = LH - THROWER_FULL_H / 2;
  const bob = Math.abs(Math.sin(now / 320)) * 10;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.font = 'bold 22px "Cubic11", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillText("⬆", cx, headTopY - 40 - bob);
  ctx.font = 'bold 11px "Cubic11", sans-serif';
  ctx.fillText("向上滑動丟出去！", cx, headTopY + 25);
  ctx.restore();
}

// One-time tooltip the first time a decoy shows up, pointing from its held
// slot toward whichever side its *correct* target (DecoyDef.correctTarget)
// entered from — grandpa wants the wheelchair, gf wants the taxi.
function drawDecoyHint(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  if (!gs.decoyHintActive || !gs.decoySwap || !gs.sideTargets) return;
  const pulse = 1 + Math.sin(now / 160) * 0.05;
  const tipX = batchSlotX(gs.decoySwap.slot),
    tipY = THROWER_ITEM_Y() - 60;
  const correctTarget = gs.decoySwap.def.correctTarget;
  const correctSide =
    correctTarget === "taxi"
      ? gs.sideTargets.taxiSide
      : gs.sideTargets.taxiSide === "left"
        ? "right"
        : "left";
  const bx = sideTargetRestX(correctSide),
    by = sideTargetY();

  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.scale(pulse, pulse);
  drawFramedLines(
    ctx,
    0,
    0,
    [
      "⚠️ 別丟進垃圾桶！",
      `丟到${correctSide === "left" ? "左邊" : "右邊"}${
        correctTarget === "taxi" ? "計程車" : "輪椅"
      }`,
    ],
    13,
  );
  ctx.restore();

  // Arrow pointing from the tooltip toward the taxi
  ctx.save();
  ctx.strokeStyle = "#ffe08a";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY + 24);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// The two new throw targets that replace the old "put down" button — slide in
// from opposite screen edges whenever a held slot is currently a decoy.
// Placeholder art (taxi.png / wheelchair.png under sprites/stage2/) falls back
// to an emoji + colored plate until the real sprites are dropped in.
function drawSideTargets(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  const st = gs.sideTargets;
  if (!st) return;

  const drawOne = (
    side: "left" | "right",
    targetKind: "taxi" | "wheelchair",
    file: string,
    emoji: string,
    plateColor: string,
  ) => {
    const restX = sideTargetRestX(side);
    const offX = sideTargetOffX(side);
    // 圖片本身只畫了車頭朝左的方向；貼在螢幕左邊、或往右邊逃跑時都要水平鏡射，
    // 車頭／人物才會朝向畫面中間（或逃跑方向），而不是朝外面。
    const mirror = side === "left";
    // 丟錯時，被丟中的這一個要反向逃到「另一邊」畫面外，而不是照原路退回近邊
    // （見 checkThrowLanding 設定 SideTargets.chasedTarget）。
    const isChased = st.exitAt !== null && st.chasedTarget === targetKind;

    let x: number;
    if (isChased) {
      const chaseOffX = sideTargetOffX(side === "left" ? "right" : "left");
      const dir = mirror ? 1 : -1;
      const gap = SIDE_TARGET_SIZE * SIDE_TARGET_CHASE_GAP_RATIO;
      // 多跑一段 gap 的距離（讓終點超出畫面外一點）——這樣被追的計程車／輪椅
      // 停下來（t=1）時，落後 gap 距離的 police 也剛好完全跑出畫面，而不是還
      // 停在畫面上動畫就結束了。
      const totalTravel = chaseOffX - restX + dir * gap;
      const t = Math.min(1, (now - st.exitAt!) / SIDE_TARGET_CHASE_EXIT_MS);
      // 前段慢、後段快的加速曲線（比一般退場的 t*t 更明顯）。
      const eased = t * t * t;
      x = restX + totalTravel * eased;
    } else if (st.exitAt === null) {
      const t = Math.min(1, (now - st.enterAt) / SIDE_TARGET_ENTER_MS);
      x = offX + (restX - offX) * (1 - (1 - t) * (1 - t));
    } else {
      const t = Math.min(1, (now - st.exitAt) / SIDE_TARGET_EXIT_MS);
      x = restX + (offX - restX) * (t * t);
    }
    const y = sideTargetY();
    const img = SIDE_TARGET_IMG_CACHE.get(file);
    // Flashes whichever target was actually hit (see checkThrowLanding), not
    // always the taxi — grandpa's correct target is the wheelchair.
    const flashing = now < st.flashUntil && st.flashTarget === targetKind;

    if (isChased) {
      const policeX =
        x - (mirror ? 1 : -1) * SIDE_TARGET_SIZE * SIDE_TARGET_CHASE_GAP_RATIO;
      ctx.save();
      ctx.translate(policeX, y);
      if (mirror) ctx.scale(-1, 1);
      drawSpriteImg(
        ctx,
        POLICE_IMG,
        SIDE_TARGET_SIZE * SIDE_TARGET_CHASE_POLICE_SIZE_RATIO,
      );
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    if (mirror) ctx.scale(-1, 1);
    if (flashing) {
      ctx.shadowColor = st.flashGood ? "#4ade80" : "#ff3030";
      ctx.shadowBlur = 22;
    }
    if (img && img.complete && img.naturalWidth > 0) {
      drawSpriteImg(ctx, img, SIDE_TARGET_SIZE);
    } else {
      ctx.fillStyle = plateColor;
      drawRoundRect(
        ctx,
        -SIDE_TARGET_SIZE / 2,
        -SIDE_TARGET_SIZE / 2,
        SIDE_TARGET_SIZE,
        SIDE_TARGET_SIZE,
        12,
      );
      ctx.fill();
      ctx.font = EMOJI_FONT(SIDE_TARGET_SIZE * 0.55);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emoji, 0, 0);
    }
    ctx.restore();
  };

  const wheelchairSide = st.taxiSide === "left" ? "right" : "left";
  drawOne(
    st.taxiSide,
    "taxi",
    st.taxiOccupantImg ?? "taxi.png",
    "🚕",
    "#f0c040",
  );
  drawOne(
    wheelchairSide,
    "wheelchair",
    st.wheelchairOccupantImg ?? "wheelchair.png",
    "♿",
    "#5a6b8c",
  );
}

// Draws the net at its current held position, facing whichever way it's
// currently moving. Only ever called while gs.netActive is true.
function drawNet(ctx: CanvasRenderingContext2D, gs: GameState) {
  if (!gs.netActive) return;
  const img = NET_IMG_CACHE.get(
    gs.netFacing === "left" ? "net_left.png" : "net_right.png",
  );
  ctx.save();
  ctx.translate(gs.netX, gs.netY);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 8;
  drawSpriteImg(ctx, img, NET_SIZE);
  ctx.restore();
}

// Bonus Time's gesture (press-and-hold, then move the net around) isn't
// obvious from "click" alone — this animates the net sliding back and forth
// until the player actually holds it down once, however long that takes.
function drawNetHint(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  if (gs.hasCaughtOnce || now < gs.bonusIntroUntil) return;
  const cycle = 1400;
  const t = (now % cycle) / cycle; // 0..1
  const swing = t < 0.5 ? t / 0.5 : 1 - (t - 0.5) / 0.5; // 0→1→0, so the net slides out and back
  const startX = LW * 0.3,
    endX = LW * 0.7;
  const y = LH * 0.46;
  const x = startX + (endX - startX) * swing;
  const facing = t < 0.5 ? "net_right.png" : "net_left.png";

  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.translate(x, y);
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 8;
  drawSpriteImg(ctx, NET_IMG_CACHE.get(facing), NET_SIZE * 0.8);
  ctx.restore();

  ctx.save();
  ctx.font = 'bold 15px "Cubic11", sans-serif';
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillText("按住畫面移動網子，接住掉落的垃圾！", LW / 2, y - 54);
  ctx.restore();
}

function drawPopups(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  for (const p of gs.popups) {
    const age = (now - p.born) / 900;
    const alpha = 1 - age;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = p.color;
    ctx.font = 'bold 18px "Cubic11", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText(p.text, p.x, p.y - age * 40);
    ctx.restore();
  }
}

// ▼▼▼ 垃圾車來襲過場動畫在這裡調整 ▼▼▼
// 垃圾車圖片高度 — 數字越大車子越大（寬度會依圖片比例自動等比縮放）。
const TRUCK_DRAW_H = 300;
// 垃圾車垂直位置，佔畫面高度的比例（0 為最上方、1 為最下方）；
// 這個過場只會在 Bonus Time 開始、垃圾桶還沒畫出來時播放，所以不用擔心跟垃圾桶疊在一起。
const TRUCK_Y_RATIO = 0.65;
// 垃圾車目前實際畫出來的寬度（依圖片比例換算）— 進場/出場的位置都靠這個數字計算，
// 車子放大時進出場位置會自動跟著變，才不會車身還沒完全開出畫面外小遊戲就開始了。
const truckDrawW = () =>
  TRUCK_IMG.complete && TRUCK_IMG.naturalWidth > 0
    ? (TRUCK_DRAW_H * TRUCK_IMG.naturalWidth) / TRUCK_IMG.naturalHeight
    : TRUCK_DRAW_H * 2.5;
function drawTruck(ctx: CanvasRenderingContext2D, gs: GameState) {
  if (!gs.truckActive) return;
  const img = TRUCK_IMG;
  if (!img.complete || img.naturalWidth === 0) return;
  ctx.save();
  const drawW = truckDrawW();
  const truckY = LH * TRUCK_Y_RATIO;
  ctx.drawImage(
    img,
    gs.truckX - drawW / 2,
    truckY - TRUCK_DRAW_H / 2,
    drawW,
    TRUCK_DRAW_H,
  );
  ctx.restore();
}

// Brief title-card beat when Bonus Time begins, instead of items just instantly appearing
function drawBonusIntro(
  ctx: CanvasRenderingContext2D,
  gs: GameState,
  now: number,
) {
  const remain = gs.bonusIntroUntil - now;
  if (remain <= 0) return;
  const p = 1 - remain / BONUS_INTRO_MS;
  const scale = p < 0.3 ? 0.6 + (p / 0.3) * 0.5 : 1; // pop in, then hold
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${0.45 * Math.min(1, p * 4)})`;
  ctx.fillRect(0, 0, fullLW(), LH);
  ctx.translate(fullLW() / 2, LH / 2);
  ctx.scale(scale, scale);
  ctx.font = 'bold 30px "Cubic11", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffd23f";
  ctx.shadowColor = "#ff8c00";
  ctx.shadowBlur = 16;
  ctx.fillText("🚛 垃圾車來襲！", 0, -14);
  ctx.font = 'bold 15px "Cubic11", sans-serif';
  ctx.fillStyle = "#fff";
  ctx.shadowBlur = 6;
  ctx.fillText("按住畫面移動網子接住垃圾拿 Bonus！", 0, 20);
  ctx.restore();
}

// SCORE / TIME now live in a DOM panel top-left (mirrors GameCanvas) — this
// only draws the transient banners (warnings, penalty messages).
function drawHUD(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  ctx.textBaseline = "middle";

  const timeToBonus =
    gs.phase === "throw" ? THROW_PHASE_MS - gs.elapsed : Infinity;
  const warningActive =
    gs.phase === "throw" && timeToBonus > 0 && timeToBonus <= BONUS_WARNING_MS;

  // Warning banner counts down the last few seconds before Bonus Time so the
  // switch never feels like it comes out of nowhere
  if (warningActive) {
    const pulse = 1 + Math.sin(now / 130) * 0.08;
    ctx.save();
    ctx.translate(LW / 2, 56);
    ctx.scale(pulse, pulse);
    drawFramedLines(
      ctx,
      0,
      0,
      [`⚠️ 垃圾車即將來襲！ ${Math.ceil(timeToBonus / 1000)}s`],
      13,
    );
    ctx.restore();
  }

  // Small countdown so the one-time bin reorder doesn't blindside the player either
  const timeToReorder = BIN_REORDER_AT_MS - gs.elapsed;
  const reorderWarningActive =
    gs.phase === "throw" &&
    !gs.binReorderTriggered &&
    timeToReorder > 0 &&
    timeToReorder <= BIN_REORDER_WARNING_MS;
  if (reorderWarningActive) {
    const pulse = 1 + Math.sin(now / 140) * 0.08;
    ctx.save();
    ctx.translate(LW / 2, 56);
    ctx.scale(pulse, pulse);
    drawFramedLines(
      ctx,
      0,
      0,
      [`🔄 垃圾桶即將換位置！ ${Math.ceil(timeToReorder / 1000)}s`],
      12,
    );
    ctx.restore();
  }

  // Banner only flashes briefly at the start of Bonus Time, tucked right under the HUD bar
  // so it never sits over the play area where flying items are
  if (gs.phase === "bonus" && now < gs.bonusBannerUntil) {
    const pulse = 1 + Math.sin(now / 120) * 0.06;
    const age = 1 - (gs.bonusBannerUntil - now) / BONUS_BANNER_MS;
    ctx.save();
    ctx.globalAlpha = age > 0.7 ? 1 - (age - 0.7) / 0.3 : 1;
    ctx.translate(LW / 2, 56);
    ctx.scale(pulse, pulse);
    ctx.font = 'bold 14px "Cubic11", sans-serif';
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd23f";
    ctx.shadowColor = "#ff8c00";
    ctx.shadowBlur = 8;
    ctx.fillText("🚛 垃圾車突襲 BONUS TIME！", 0, 0);
    ctx.restore();
  }

  if (gs.lastPenaltyMsg && now < gs.flashUntil + 1600) {
    drawFramedLines(ctx, LW / 2, 96, [gs.lastPenaltyMsg], 14, {
      textColor: "#ffb0b0",
      borderColor: "#7a2020",
    });
  }
}

// Result screen — canvas-drawn to match GameCanvas's (Level 1) drawGameOver
// exactly: same dark overlay, text sizing formulas, colors, and layout.
// Level 2 only ever ends by the clock running out, so there's no "GAME OVER"
// (fail) branch — always the amber "時間到！" title.
function drawGameOver(ctx: CanvasRenderingContext2D, gs: GameState) {
  const fullW = fullLW();
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, 0, fullW, LH);

  const atLeastPhys = (minPx: number) => Math.ceil(minPx / GS);
  const titleSize = Math.max(atLeastPhys(28), Math.round(LH * 0.057));
  const scoreSize = Math.max(atLeastPhys(16), Math.round(LH * 0.034));
  const promptSize = Math.max(atLeastPhys(13), Math.round(LH * 0.029));
  const cx = fullW / 2;
  const cy = LH / 2;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f0c040";
  ctx.font = `bold ${titleSize}px 'Cubic11', sans-serif`;
  ctx.fillText("⏰ 時間到！", cx, cy - Math.round(LH * 0.114));

  ctx.fillStyle = "#fff";
  ctx.font = `bold ${scoreSize}px 'Cubic11', sans-serif`;
  ctx.fillText(`最終分數：${gs.score}`, cx, cy - Math.round(LH * 0.043));

  ctx.fillStyle = "#f0c040";
  ctx.font = `${promptSize}px 'Cubic11', sans-serif`;
  ctx.fillText(`最高分：${gs.best}`, cx, cy + Math.round(LH * 0.014));

  ctx.fillStyle = "#4ade80";
  ctx.font = `bold ${promptSize}px 'Cubic11', sans-serif`;
  ctx.fillText("點擊畫面重新開始", cx, cy + Math.round(LH * 0.1));
  ctx.restore();
}

function render(ctx: CanvasRenderingContext2D, gs: GameState, now: number) {
  ctx.save();
  ctx.scale(GS, GS);

  // Full-bleed background spans the whole physical canvas (fullLW() can be
  // wider than the fixed-design LW on wide/landscape screens).
  drawBackground(ctx, gs.phase);

  // The fixed-design content (LW × LH) is centered within that full width
  // instead of pinned to the left edge — this is what keeps everything
  // looking centered rather than skewed on wide viewports.
  ctx.save();
  const offsetX = (fullLW() - LW) / 2;
  ctx.translate(offsetX, 0);
  if (now < gs.shakeUntil) {
    ctx.translate(rng(-6, 6), rng(-6, 6));
  }

  // Ambient background cameo drawn first so it sits behind the bins/thrower/items.
  if (gs.phase === "throw") drawBgDecoy(ctx, gs, now);
  if (gs.phase === "throw") drawBins(ctx, gs, now);
  if (gs.phase === "throw") drawSideTargets(ctx, gs, now);
  drawTruck(ctx, gs);
  for (const it of gs.flying) drawFlyingItem(ctx, it);
  if (gs.phase === "throw") {
    drawPowerBar(ctx, gs);
    drawThrower(ctx, gs, now);
    drawSwipeHint(ctx, gs, now);
    drawDecoyHint(ctx, gs, now);
  }
  if (gs.phase === "bonus") {
    drawNetHint(ctx, gs, now);
    drawNet(ctx, gs);
  }
  drawPopups(ctx, gs, now);
  drawHUD(ctx, gs, now);
  ctx.restore();

  if (gs.phase === "bonus") drawBonusIntro(ctx, gs, now);

  if (now < gs.flashUntil) {
    ctx.fillStyle = gs.flashColor;
    ctx.globalAlpha = 0.35 * (1 - (now - (gs.flashUntil - 220)) / 220);
    ctx.fillRect(0, 0, fullLW(), LH);
    ctx.globalAlpha = 1;
  }

  if (gs.status === "gameover") drawGameOver(ctx, gs);

  ctx.restore();
}

// ─── Component ──────────────────────────────────────────────────────────────
interface Level2Props {
  onBack: () => void;
}

export default function Level2({ onBack }: Level2Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const gsRef = useRef<GameState>(initState(getBestForLevel(2)));
  const rafRef = useRef(0);
  const exitConfirmRef = useRef(false);

  const [status, setStatus] = useState<"idle" | "playing" | "gameover">("idle");
  const [scoreDisplay, setScoreDisplay] = useState(0);
  const [timeLeftDisplay, setTimeLeftDisplay] = useState(TOTAL_MS);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [vpW, setVpW] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 390,
  );
  const [vpH, setVpH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 700,
  );

  const startGame = useCallback(() => {
    const best = gsRef.current.best;
    gsRef.current = initState(best);
    gsRef.current.status = "playing";
    gsRef.current.lastFrameTs = performance.now();
    setStatus("playing");
    startGame2Bgm();
  }, []);

  // Background audio is now the synthesized chiptune BGM (startGame2Bgm / Für
  // Elise) rather than a video's own soundtrack. This still calls play() in
  // case the background <video> is swapped back in later — a harmless no-op
  // while it's commented out in favor of the static <img> below.
  useEffect(() => {
    videoRef.current?.play().catch(() => {});
  }, []);

  // ── Render loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let statusSent = gsRef.current.status;
    let lastHudSync = 0;

    const loop = (now: number) => {
      const gs = gsRef.current;
      const dt = Math.min(now - gs.lastFrameTs, 50);
      gs.lastFrameTs = now;
      if (gs.status === "playing" && !exitConfirmRef.current)
        update(gs, now, dt);
      render(ctx, gs, now);
      if (gs.status !== statusSent) {
        statusSent = gs.status;
        setStatus(gs.status);
      }
      // Sync SCORE/TIME to the DOM HUD only every ~100ms to avoid excessive re-renders
      if (now - lastHudSync > 100) {
        lastHudSync = now;
        setScoreDisplay(gs.score);
        setTimeLeftDisplay(Math.max(0, TOTAL_MS - gs.elapsed));
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      stopFurElise();
      stopGame2Bgm();
    };
  }, []);

  // ── Resize / orientation ──────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      const p = isPortraitViewport();
      CW = window.innerWidth;
      CH = window.innerHeight;
      LW = p ? 390 : 720;
      GS = p ? CW / LW : Math.min(CW / LW, CH / 480);
      LH = Math.round(CH / GS);
      if (canvasRef.current) {
        canvasRef.current.width = CW;
        canvasRef.current.height = CH;
      }
      setVpW(CW);
      setVpH(CH);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Pointer handling ──────────────────────────────────────────────────────
  // Canvas pixels are physical (CW×CH); divide by GS to land back in the
  // logical (LW×LH) coordinate space that all game/draw code works in, then
  // undo the same centering offset render() applies to the drawn content.
  const toLocal = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const scale = CW / rect.width;
    const offsetX = (fullLW() - LW) / 2;
    return {
      x: ((e.clientX - rect.left) * scale) / GS - offsetX,
      y: ((e.clientY - rect.top) * scale) / GS,
    };
  }, []);

  // Free-pick: a pointer-down only starts aiming if it lands close enough to
  // one of the held batch slots (whichever is non-empty and closest within range).
  const hitTestBatchSlot = useCallback(
    (gs: GameState, p: { x: number; y: number }) => {
      let best: number | null = null;
      let bestDist = Infinity;
      gs.queueBatch.forEach((item, i) => {
        if (!item) return;
        const d = Math.hypot(p.x - batchSlotX(i), p.y - THROWER_ITEM_Y());
        if (d <= BATCH_SLOT_HIT_R && d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      return best;
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const gs = gsRef.current;
      // Matches GameCanvas (Level 1) — clicking anywhere on the canvas while
      // the result screen is showing restarts immediately.
      if (gs.status === "gameover") {
        startGame();
        return;
      }
      if (gs.status !== "playing") return;
      const p = toLocal(e);
      if (gs.phase === "throw") {
        const slot = hitTestBatchSlot(gs, p);
        if (slot === null) return;
        gs.aimSlot = slot;
        gs.aimStart = p;
        gs.aimCurrent = p;
      } else {
        gs.hasCaughtOnce = true;
        gs.netActive = true;
        gs.netX = p.x;
        gs.netY = p.y;
      }
    },
    [toLocal, hitTestBatchSlot, startGame],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const gs = gsRef.current;
      if (gs.status !== "playing") return;
      const p = toLocal(e);
      if (gs.phase === "throw" && gs.aimSlot !== null) {
        gs.aimCurrent = p;
      } else if (gs.phase === "bonus" && gs.netActive) {
        const dx = p.x - gs.netX;
        if (dx > 2) gs.netFacing = "right";
        else if (dx < -2) gs.netFacing = "left";
        gs.netX = p.x;
        gs.netY = p.y;
      }
    },
    [toLocal],
  );

  const launch = useCallback(() => {
    const gs = gsRef.current;
    if (gs.aimSlot === null || !gs.aimStart || !gs.aimCurrent) {
      gs.aimSlot = null;
      return;
    }
    const slot = gs.aimSlot;
    // Velocity follows the finger's motion (flick-style): current − start
    const dx = gs.aimCurrent.x - gs.aimStart.x;
    const dy = gs.aimCurrent.y - gs.aimStart.y;
    const dist = Math.hypot(dx, dy);
    gs.aimSlot = null;
    if (dist < MIN_DRAG_DIST || dy > -MIN_DRAG_DIST * 0.5) {
      gs.aimStart = null;
      gs.aimCurrent = null;
      return;
    }

    let vx = dx * DRAG_K,
      vy = dy * DRAG_K;
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_LAUNCH_SPEED) {
      vx *= MAX_LAUNCH_SPEED / speed;
      vy *= MAX_LAUNCH_SPEED / speed;
    }

    const q = gs.queueBatch[slot];
    if (!q) return; // shouldn't happen — hitTestBatchSlot only selects non-empty slots
    gs.flying.push({
      id: gs.idCounter++,
      kind: q.kind,
      category: q.category,
      icon: q.icon,
      label: q.label,
      x: batchSlotX(slot),
      y: THROWER_ITEM_Y(),
      vx,
      vy,
      rot: 0,
      vrot: rng(-4, 4),
      bonus: false,
    });
    gs.hasThrownOnce = true;
    gs.queueBatch[slot] = null;
    refillBatchIfEmpty(gs);
    gs.aimStart = null;
    gs.aimCurrent = null;
  }, []);

  const onPointerUp = useCallback(() => {
    const gs = gsRef.current;
    if (gs.status !== "playing") return;
    // Bonus Time's net stays put at its last held position after release
    // instead of vanishing — it only ever appears/moves again on the next
    // pointerDown/Move, and stops being drawn once Bonus Time itself ends
    // (drawNet is gated on gs.phase === "bonus").
    if (gs.phase === "throw") launch();
  }, [launch]);

  // ── DOM HUD sizing (mirrors GameCanvas's panelBase/uiScale) ─────────────
  const uiScale = Math.min(1.6, Math.max(0.65, Math.min(vpW, vpH) / 480));
  const s = (n: number) => Math.round(n * uiScale);
  const panelBase: React.CSSProperties = {
    background: "rgba(5,15,40,0.92)",
    border: "2px solid #1e3a6e",
    borderRadius: s(8),
    fontFamily: '"Cubic11", "Courier New", Courier, monospace',
    boxShadow:
      "0 4px 16px rgba(0,0,0,0.7), inset 0 1px 0 rgba(100,160,255,0.08)",
    color: "#fff",
  };
  const secLeft = Math.ceil(timeLeftDisplay / 1000);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* Background scene art behind the (transparent) canvas — currently a static
          <img> (below); the <video> version is kept here commented out in case
          it's swapped back in. Audio is the separate synthesized BGM, not tied
          to whichever of these is showing. */}
      <video
        ref={videoRef}
        src={game2BgSrc}
        autoPlay
        loop
        playsInline
        style={{
          position: "absolute",
          top: "50%",
          left: 0,
          width: "100%",
          height: "auto",
          transform: "translateY(-50%)",
          display: "block",
        }}
      />
      {/* <img
        src={game2BgSrc}
        style={{
          position: "absolute",
          top: "50%",
          left: 0,
          width: "100%",
          height: "auto",
          transform: "translateY(-50%)",
          display: "block",
        }}
      /> */}

      {/* Canvas fills the real viewport pixel-for-pixel — no CSS upscaling, so it stays sharp */}
      <canvas
        ref={canvasRef}
        width={vpW}
        height={vpH}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          touchAction: "none",
          cursor: "default",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {/* SCORE / TIME — top-left, mirrors GameCanvas's HUD layout */}
      {status === "playing" && (
        <div
          style={{
            position: "absolute",
            top: s(8),
            left: s(8),
            display: "flex",
            gap: s(6),
            zIndex: 40,
          }}
        >
          <div
            style={{
              ...panelBase,
              padding: `${s(4)}px ${s(10)}px ${s(5)}px`,
              minWidth: s(96),
            }}
          >
            <div
              style={{
                fontSize: s(9),
                color: "#f0c040",
                letterSpacing: s(2),
                fontWeight: 700,
                marginBottom: s(1),
              }}
            >
              SCORE
            </div>
            <div
              style={{
                fontSize: s(20),
                fontWeight: 700,
                color: "#f0c040",
                letterSpacing: 1,
              }}
            >
              {scoreDisplay}
            </div>
          </div>

          <div
            style={{
              ...panelBase,
              padding: `${s(4)}px ${s(10)}px ${s(5)}px`,
              minWidth: s(78),
            }}
          >
            <div
              style={{
                fontSize: s(9),
                color: "#aad4ff",
                letterSpacing: s(2),
                fontWeight: 700,
                marginBottom: s(1),
              }}
            >
              TIME
            </div>
            <div
              style={{
                fontSize: s(20),
                fontWeight: 700,
                color: secLeft <= 10 ? "#f87171" : "#fff",
                letterSpacing: 1,
                display: "flex",
                alignItems: "center",
                gap: s(4),
                animation: secLeft <= 10 ? "blink 0.8s infinite" : "none",
              }}
            >
              <span style={{ fontSize: s(13) }}>⏱</span>
              {secLeft}
            </div>
          </div>
        </div>
      )}

      {/* Exit button — top-right, opens a confirm dialog instead of leaving instantly.
          Same image-button treatment as GameCanvas (Level 1) for a consistent look. */}
      {status === "playing" && (
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            exitConfirmRef.current = true;
            setShowExitConfirm(true);
          }}
          style={{
            position: "absolute",
            top: s(8),
            right: s(8),
            zIndex: 40,
            width: s(60),
            height: s(60),
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            touchAction: "manipulation",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}sprites/back.png`}
            alt="返回"
            draggable={false}
            style={{ width: s(60), height: s(60), objectFit: "contain" }}
          />
        </button>
      )}

      {/* Exit confirmation modal */}
      {showExitConfirm && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 100,
            background: "rgba(0,0,0,0.82)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "rgba(5,15,40,0.92)",
              border: "2px solid rgb(30,58,110)",
              borderRadius: s(8),
              fontFamily: '"Cubic11", "Courier New", Courier, monospace',
              boxShadow:
                "rgba(0,0,0,0.7) 0px 4px 16px, rgba(100,160,255,0.08) 0px 1px 0px inset",
              color: "#fff",
              minWidth: s(260),
            }}
          >
            <div
              style={{
                padding: `${s(22)}px ${s(24)}px ${s(20)}px`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: s(6),
              }}
            >
              <div
                style={{
                  color: "#f0c040",
                  fontWeight: 700,
                  fontSize: s(16),
                  textAlign: "center",
                  letterSpacing: 1,
                }}
              >
                確定要返回大廳嗎？
              </div>
              <div
                style={{
                  color: "#f87171",
                  fontSize: s(12),
                  fontWeight: 700,
                  textAlign: "center",
                  letterSpacing: 0.5,
                  animation: "blink 1s infinite",
                }}
              >
                ！ 此關成績將會歸零 ！
              </div>

              <div style={{ display: "flex", gap: s(10), marginTop: s(16) }}>
                <button
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    exitConfirmRef.current = false;
                    setShowExitConfirm(false);
                    onBack();
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}sprites/backto.png`}
                    alt="返回大廳"
                    draggable={false}
                    style={{ height: s(48), objectFit: "contain" }}
                  />
                </button>
                <button
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    exitConfirmRef.current = false;
                    setShowExitConfirm(false);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}sprites/keep-play.png`}
                    alt="繼續遊戲"
                    draggable={false}
                    style={{ height: s(48), objectFit: "contain" }}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Back button — hidden mid-play so it doesn't overlap the HUD.
          Same scaled gradient button as GameCanvas (Level 1) for a consistent look. */}
      {status !== "playing" && (
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            onBack();
          }}
          style={{
            position: "absolute",
            top: s(10),
            left: s(10),
            zIndex: 60,
            padding: `${s(8)}px ${s(14)}px`,
            background: "linear-gradient(135deg,rgb(30,58,138),rgb(37,99,235))",
            border: "2px solid rgba(147,197,253,0.7)",
            borderRadius: s(6),
            color: "#fff",
            fontWeight: 700,
            cursor: "pointer",
            touchAction: "none",
            userSelect: "none",
            boxShadow:
              "rgba(37,99,235,0.5) 0px 4px 14px, rgba(255,255,255,0.15) 0px 1px 0px inset",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: s(2),
          }}
        >
          <span style={{ fontSize: s(14), lineHeight: 1 }}>←</span>
          <span
            style={{
              fontSize: s(12),
              fontWeight: 700,
              letterSpacing: 0.5,
              fontFamily: '"Cubic11", "Courier New", Courier, monospace',
            }}
          >
            返回大廳
          </span>
        </button>
      )}

      {/* Idle screen */}
      {status === "idle" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(8,16,36,0.94)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            gap: 10,
            textAlign: "center",
            fontFamily: "'Cubic11', sans-serif",
            color: "#fff",
          }}
        >
          {/* <div style={{ fontSize: 46 }}>♻️</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#60a5fa" }}>
            垃圾分類王
          </div> */}
          {/* 開頭規則說明圖 — 撐滿可用高度，寬度依圖片比例縮放，
              左右多出的空間就露出外層的半透明黑底（不額外貼色底）。 */}
          <button
            onPointerDown={startGame}
            style={{
              height: "100vh",
              // maxHeight: 420,
              width: "auto",
              // maxWidth: "94vw",
              objectFit: "contain",
            }}
          >
            <img
              src={game2InfoSrc}
              alt="遊戲說明"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
              }}
            />
          </button>
          {/* <button
            onPointerDown={startGame}
            style={{
              marginTop: 10,
              padding: "12px 32px",
              background: "linear-gradient(135deg,#2f6fd6,#1c4fa8)",
              color: "#fff",
              border: "2px solid #60a5fa",
              borderRadius: 12,
              fontSize: 17,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "'Cubic11', sans-serif",
              touchAction: "manipulation",
            }}
          >
            開始遊戲 →
          </button> */}
        </div>
      )}

      {/* Gameover screen is now canvas-drawn (see drawGameOver) to match
          GameCanvas (Level 1) exactly — clicking the canvas restarts, same as
          Level 1's "點擊畫面重新開始" (see onPointerDown below); the persistent
          top-left "返回大廳" button above already covers leaving. */}
    </div>
  );
}
