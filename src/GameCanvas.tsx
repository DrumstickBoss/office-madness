import { useRef, useEffect, useState, useCallback } from "react";
import { addRecord, getBestForLevel } from "./leaderboard";
import game1BgSrc from "./assets/game1_bgm.mp4";

// ─── Canvas dimensions (mutable — updated on orientation change) ─────────────
const isPortraitViewport = () =>
  typeof window !== "undefined" && window.innerWidth < window.innerHeight;

let CW = typeof window !== "undefined" ? window.innerWidth : 390;
let CH = typeof window !== "undefined" ? window.innerHeight : 700;

// Logical game coordinate space (fixed reference, same as before)
const _p0 = typeof window !== "undefined" && isPortraitViewport();
let LW = _p0 ? 390 : 720; // logical width
let GS = typeof window !== "undefined" ? window.innerWidth / LW : 1; // game scale
let LH =
  typeof window !== "undefined"
    ? Math.round(window.innerHeight / GS)
    : _p0
      ? 700
      : 480;

// ─── Game tuning ─────────────────────────────────────────────────────────────
const PLAYER_W = 72;
const PLAYER_H = 88;
const ITEM_SIZE = 44;
const ITEM_SPAWN_MS = 1200;
const CALL_SPAWN_MS = 10_000;
const CALL_TIMEOUT_MS = 3000; // seconds before call auto-expires
const FREEZE_MS = 2000; // freeze duration for any mistake
const GAME_DURATION_MS = 60_000; // 1-minute countdown
const PLAYER_SPEED = 8; // px per frame at 60fps
const SCORE_LEGIT_ANSWER = 20; // bonus for correctly answering legit call
const SCORE_LEGIT_MISS = -50; // missed legit call penalty
const SCORE_SPECIAL = 100; // bonus for catching today's special
const FAT_DURATION_MS = 3000; // wrong-meal fat/slow duration
const MISSION_TARGET = 500; // score target for the daily mission

// ─── Meal catalogue ───────────────────────────────────────────────────────────
const MEAL_FILES = [
  "food-1.png",
  "food-2.png",
  "food-3.png",
  "food-4.png",
  "food-5.png",
  "food-6.png",
  "food-7.png",
];

// Daily special is drawn from all available meals
const SPECIAL_MEAL_FILES = MEAL_FILES;

// Module-level image cache — starts loading immediately when the module is imported
const IMG_CACHE = new Map<string, HTMLImageElement>();
MEAL_FILES.forEach((file) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/${file}`;
  IMG_CACHE.set(file, img);
});

// Player sprites
const _mkImg = (src: string) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/${src}`;
  return img;
};
const PLAYER_IMG_FIT = _mkImg("fit_aDou.png");
const PLAYER_IMG_FAT = _mkImg("fat_aDou.png");
const PLAYER_IMG_FROZEN_FIT = _mkImg("frozen-m.png");
const PLAYER_IMG_FROZEN_FAT = _mkImg("frozen-xl.png");

// ─── Character system ─────────────────────────────────────────────────────────
const SHIELD_RECHARGE_MS = 15_000;
const PHONE_BOOST_MS = 5_000;
const MAX_SHIELDS = 2;

type CharacterId = "bento" | "shield" | "phone";

const LEGIT_CALLERS = [
  { name: "老闆", sub: "週報發了嗎？", avatar: "boss.png" },
  { name: "PM 緊急", sub: "需求又改了！", avatar: "female-boss.png" },
  { name: "董事長", sub: "你在哪？快接！", avatar: "boss.png" },
  { name: "大客戶", sub: "緊急問題！", avatar: "female-boss.png" },
  { name: "主管", sub: "現在有空嗎？", avatar: "boss.png" },
  { name: "人資", sub: "面談時間確認", avatar: "female-boss.png" },
];

const SCAM_CALLERS = [
  { name: "股票飆股達人", sub: "年報酬 300%！", avatar: "stock.png" },
  { name: "低利房貸免審", sub: "今天就撥款！", avatar: "bank.png" },
  { name: "恭喜！您中獎了", sub: "領取百萬大獎！", avatar: "Thief.png" },
  { name: "外國投資機構", sub: "保證獲利！", avatar: "bank.png" },
  { name: "法院傳票通知", sub: "立即接聽！（詐騙）", avatar: "court.png" },
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface FallingItem {
  id: number;
  x: number;
  y: number;
  mealFile: string;
  speed: number;
}

interface PhoneCall {
  id: number;
  side: "left" | "right";
  type: "legit" | "scam";
  caller: string;
  sub: string;
  avatar: string;
  spawnTime: number;
  resolved: boolean;
}

interface GameState {
  status: "idle" | "playing" | "gameover";
  score: number;
  hiScore: number;
  playerX: number;
  targetX: number;
  frozen: boolean;
  frozenUntil: number;
  frozenMsg: string | null;
  items: FallingItem[];
  calls: PhoneCall[];
  nextItemTime: number;
  nextCallTime: number;
  idCounter: number;
  lastFrameTs: number;
  elapsed: number;
  timeLeft: number;
  timeUp: boolean;
  callsDirty: boolean;
  // Character
  character: CharacterId;
  comboCount: number; // bento: consecutive bentos collected
  comboActive: boolean; // bento: double-score mode (comboCount >= 3)
  shields: number; // shield: current shield count
  nextShieldTime: number; // shield: timestamp for next recharge
  phoneBoostUntil: number; // phone: boost active until this timestamp
  // Daily special
  dailySpecial: string[]; // today's two special meal filenames
  fat: boolean; // player ate wrong meal — slower
  fatUntil: number; // when fat effect expires
  combo: number; // consecutive correct specials caught
  maxCombo: number; // session best combo
}

// ─── Helper: random int in [min, max] ────────────────────────────────────────
const rng = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// ─── Helper: random pick ─────────────────────────────────────────────────────
const pick = <T,>(arr: T[]): T => arr[rng(0, arr.length - 1)];

// ─── Rendering helpers ────────────────────────────────────────────────────────

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

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  fat: boolean,
  frozen = false,
) {
  const img = frozen
    ? fat
      ? PLAYER_IMG_FROZEN_FAT
      : PLAYER_IMG_FROZEN_FIT
    : fat
      ? PLAYER_IMG_FAT
      : PLAYER_IMG_FIT;
  if (img.complete && img.naturalWidth > 0) {
    // Preserve image aspect ratio, using PLAYER_H as the height reference.
    // Center the draw horizontally around the collision box midpoint.
    const drawW = Math.round((PLAYER_H * img.naturalWidth) / img.naturalHeight);
    const drawX = x + Math.round((PLAYER_W - drawW) / 2);
    ctx.drawImage(img, drawX, y, drawW, PLAYER_H);
  } else {
    ctx.fillStyle = fat ? "#c8701a" : "#4a90e2";
    ctx.fillRect(x, y, PLAYER_W, PLAYER_H);
  }
}

function drawMeal(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  file: string,
  _isSpecial = false,
) {
  const img = IMG_CACHE.get(file);

  if (!img || !img.complete || img.naturalWidth === 0) {
    ctx.save();
    ctx.fillStyle = "#555";
    drawRoundRect(ctx, x, y, ITEM_SIZE, ITEM_SIZE, 6);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.save();

  // shadowBlur on drawImage follows the image's alpha channel contour.
  // Draw the image twice so the glow accumulates and looks stronger.
  ctx.shadowColor = "rgba(255,255,255,0.95)";
  ctx.shadowBlur = 14;
  ctx.drawImage(img, x, y, ITEM_SIZE, ITEM_SIZE); // glow pass
  ctx.shadowBlur = 6;
  ctx.drawImage(img, x, y, ITEM_SIZE, ITEM_SIZE); // sharpen inner glow
  ctx.shadowBlur = 0;
  ctx.drawImage(img, x, y, ITEM_SIZE, ITEM_SIZE); // crisp final image

  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  // The background art is a real DOM <img> behind the canvas now (crisp at native
  // resolution instead of being rasterized into the small canvas buffer and
  // stretched blurry) — the canvas itself just needs to stay transparent.
  // Use CW/GS (actual canvas width in logical coords) so the clear covers the
  // full canvas even when LW×GS < CW (landscape wide-screen letterbox scenario).
  ctx.clearRect(0, 0, CW / GS, LH);
}

function drawPixelBox(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  fill: string,
  border: string,
) {
  ctx.fillStyle = fill;
  ctx.fillRect(bx + 2, by + 2, bw - 4, bh - 4);
  ctx.fillStyle = border;
  ctx.fillRect(bx + 2, by, bw - 4, 2);
  ctx.fillRect(bx + 2, by + bh - 2, bw - 4, 2);
  ctx.fillRect(bx, by + 2, 2, bh - 4);
  ctx.fillRect(bx + bw - 2, by + 2, 2, bh - 4);
  ctx.fillRect(bx + 2, by + 2, 2, 2);
  ctx.fillRect(bx + bw - 4, by + 2, 2, 2);
  ctx.fillRect(bx + 2, by + bh - 4, 2, 2);
  ctx.fillRect(bx + bw - 4, by + bh - 4, 2, 2);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillRect(bx + 4, by + 2, bw - 8, 1);
  ctx.fillRect(bx + 2, by + 4, 1, bh - 6);
}

function drawFreezeOverlay(
  ctx: CanvasRenderingContext2D,
  frozenUntil: number,
  now: number,
  playerX: number,
  playerY: number,
  extraMsg: string | null,
) {
  const remaining = Math.max(0, frozenUntil - now);
  const label = `定身中 ${(remaining / 1000).toFixed(1)}s`;
  const cx = Math.round(playerX + PLAYER_W / 2);
  const FILL = "#dbeafe";
  const BD = "#1e3a8a";
  const padX = 8;
  const bh = 22;
  const tailH = 6;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.font = "bold 11px 'Cubic11', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ── Main bubble (定身中 countdown) with tail ──
  const tw = Math.ceil(ctx.measureText(label).width);
  const bw = tw + padX * 2;
  const bx = Math.round(cx - bw / 2);
  const by = playerY - 2 - tailH - bh;

  drawPixelBox(ctx, bx, by, bw, bh, FILL, BD);

  const tx = cx,
    ty = by + bh;
  ctx.fillStyle = BD;
  ctx.fillRect(tx - 3, ty, 6, 2);
  ctx.fillRect(tx - 2, ty + 2, 4, 2);
  ctx.fillRect(tx - 1, ty + 4, 2, 2);
  ctx.fillStyle = FILL;
  ctx.fillRect(tx - 2, ty, 4, 2);
  ctx.fillRect(tx - 1, ty + 2, 2, 2);

  ctx.fillStyle = BD;
  ctx.fillText(label, cx, by + bh / 2 + 1);

  // ── Extra message bubble above (no tail) ──
  if (extraMsg) {
    const EFILL = "#fef9c3";
    const EBD = "#78350f";
    const etw = Math.ceil(ctx.measureText(extraMsg).width);
    const ebw = etw + padX * 2;
    const ebh = 22;
    const ebx = Math.round(cx - ebw / 2);
    const eby = by - ebh - 4;

    drawPixelBox(ctx, ebx, eby, ebw, ebh, EFILL, EBD);
    ctx.fillStyle = EBD;
    ctx.fillText(extraMsg, cx, eby + ebh / 2 + 1);
  }

  ctx.restore();
}

function drawIdleScreen(ctx: CanvasRenderingContext2D) {
  // fullW = actual canvas width in logical coords.
  // In landscape wide-screen (e.g. 1920×1080), LW×GS < CW so LW alone
  // leaves uncovered strips on the sides — use CW/GS to fill the whole canvas.
  const fullW = CW / GS;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(0, 0, fullW, LH);

  const cx = fullW / 2;

  // Convert a minimum physical-pixel size to the equivalent logical size.
  // When GS < 1 (landscape on small phones), logical sizes must be LARGER
  // than the physical target so that after ctx.scale(GS,GS) the result is
  // still legible.
  const atLeastPhys = (minPx: number) => Math.ceil(minPx / GS);

  const titleSize = Math.max(atLeastPhys(30), Math.round(LH * 0.063));
  const subSize = Math.max(atLeastPhys(15), Math.round(LH * 0.028));
  const ruleSize = Math.max(atLeastPhys(14), Math.round(LH * 0.026));
  const promptSize = Math.max(atLeastPhys(17), Math.round(LH * 0.038));
  const rowH = Math.round(ruleSize * 2.1);

  const gapTitle = Math.round(LH * 0.057);
  const gapRules = Math.round(LH * 0.054);
  const gapPrompt = Math.round(LH * 0.04);

  const rules = [
    { text: "接對特餐  +100 分", color: "#f0c040" },
    { text: "接錯便當  -30 分（還會變胖速度變慢）", color: "#f87171" },
    { text: "工作來電  需接聽（X / 點綠色按鈕）", color: "#e2e8f0" },
    { text: "詐騙來電  需掛斷（Z / 點紅色按鈕）", color: "#e2e8f0" },
    { text: "接錯電話  被耽誤 2 秒，無法移動", color: "#e2e8f0" },
  ];

  const totalH = gapTitle + gapRules + rules.length * rowH + gapPrompt;
  const top = LH / 2 - totalH / 2;

  // Title
  ctx.textAlign = "center";
  ctx.fillStyle = "#f0c040";
  ctx.font = `bold ${titleSize}px 'Cubic11', sans-serif`;
  ctx.fillText("社畜接便當", cx, top);

  // Subtitle
  ctx.fillStyle = "#cbd5e1";
  ctx.font = `${subSize}px 'Cubic11', sans-serif`;
  ctx.fillText("60 秒內接住螢幕上方指定的特餐便當！", cx, top + gapTitle);

  // Rule rows — fit-content block, left-aligned within centred block
  const rulesTop = top + gapTitle + gapRules;
  ctx.font = `${ruleSize}px 'Cubic11', sans-serif`;
  const maxRuleW = Math.max(...rules.map((r) => ctx.measureText(r.text).width));
  const blockLeft = Math.max(8, cx - maxRuleW / 2);
  ctx.textAlign = "left";
  rules.forEach(({ text, color }, i) => {
    ctx.fillStyle = color;
    ctx.fillText(text, blockLeft, rulesTop + i * rowH);
  });
  ctx.textAlign = "center";

  // Start prompt
  ctx.fillStyle = "#3090cf";
  ctx.font = `bold ${promptSize}px 'Cubic11', sans-serif`;
  ctx.fillText(
    "點擊畫面開始遊戲",
    cx,
    rulesTop + rules.length * rowH + gapPrompt,
  );
}

function drawGameOver(
  ctx: CanvasRenderingContext2D,
  score: number,
  hiScore: number,
  timeUp: boolean,
) {
  const fullW = CW / GS;
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, 0, fullW, LH);

  const atLeastPhys = (minPx: number) => Math.ceil(minPx / GS);
  const titleSize = Math.max(atLeastPhys(28), Math.round(LH * 0.057));
  const scoreSize = Math.max(atLeastPhys(16), Math.round(LH * 0.034));
  const promptSize = Math.max(atLeastPhys(13), Math.round(LH * 0.029));
  const cx = fullW / 2;
  const cy = LH / 2;

  ctx.textAlign = "center";
  ctx.fillStyle = timeUp ? "#f0c040" : "#e74c3c";
  ctx.font = `bold ${titleSize}px 'Cubic11', sans-serif`;
  ctx.fillText(
    timeUp ? "⏰ 時間到！" : "GAME OVER",
    cx,
    cy - Math.round(LH * 0.114),
  );

  ctx.fillStyle = "#fff";
  ctx.font = `bold ${scoreSize}px 'Cubic11', sans-serif`;
  ctx.fillText(`最終分數：${score}`, cx, cy - Math.round(LH * 0.043));

  ctx.fillStyle = "#f0c040";
  ctx.font = `${promptSize}px 'Cubic11', sans-serif`;
  ctx.fillText(`最高分：${hiScore}`, cx, cy + Math.round(LH * 0.014));

  ctx.fillStyle = "#4ade80";
  ctx.font = `bold ${promptSize}px 'Cubic11', sans-serif`;
  ctx.fillText("點擊畫面重新開始", cx, cy + Math.round(LH * 0.1));
}

// ─── Initial state factory ────────────────────────────────────────────────────
function initState(hiScore = 0, character: CharacterId = "bento"): GameState {
  return {
    status: "idle",
    score: 0,
    hiScore,
    playerX: LW / 2 - PLAYER_W / 2,
    targetX: LW / 2 - PLAYER_W / 2,
    frozen: false,
    frozenUntil: 0,
    frozenMsg: null,
    items: [],
    calls: [],
    nextItemTime: 0,
    nextCallTime: CALL_SPAWN_MS,
    idCounter: 0,
    lastFrameTs: 0,
    elapsed: 0,
    timeLeft: GAME_DURATION_MS,
    timeUp: false,
    callsDirty: false,
    character,
    comboCount: 0,
    comboActive: false,
    shields: character === "shield" ? 1 : 0,
    nextShieldTime: 0,
    phoneBoostUntil: 0,
    dailySpecial: [...SPECIAL_MEAL_FILES]
      .sort(() => Math.random() - 0.5)
      .slice(0, 2),
    fat: false,
    fatUntil: 0,
    combo: 0,
    maxCombo: 0,
  };
}

// ─── Phone call overlay (must be outside GameCanvas to keep stable identity) ──
interface CallOverlayProps {
  call: PhoneCall;
  portrait: boolean;
  uiScale: number;
  onAnswer: (id: number) => void;
  onDecline: (id: number) => void;
}

function CallOverlay({
  call,
  portrait,
  uiScale,
  onAnswer,
  onDecline,
}: CallOverlayProps) {
  const [timeLeft, setTimeLeft] = useState(CALL_TIMEOUT_MS);
  const sc = (n: number) => Math.round(n * uiScale);

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = CALL_TIMEOUT_MS - (performance.now() - call.spawnTime);
      setTimeLeft(Math.max(0, remaining));
    }, 100);
    return () => clearInterval(interval);
  }, [call.spawnTime]);

  const isLeft = call.side === "left";
  const pct = timeLeft / CALL_TIMEOUT_MS;

  const phoneW = sc(portrait ? 215 : 190);

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        ...(isLeft ? { left: sc(8) } : { right: sc(8) }),
        transform: "translateY(-50%)",
        width: phoneW,
        zIndex: 20,
        userSelect: "none",
        animation: "phoneSlideIn 0.3s ease-out",
        fontFamily: "'Cubic11', sans-serif",
      }}
    >
      {/* Phone background — determines container height via natural aspect ratio */}
      <img
        src={`${import.meta.env.BASE_URL}sprites/phone.png`}
        alt=""
        draggable={false}
        style={{ width: "100%", display: "block", pointerEvents: "none" }}
      />

      {/* ── Caller info above the circle (~8–28% from top) ── */}
      <div
        style={{
          position: "absolute",
          top: "15%",
          left: "10%",
          right: "10%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: sc(3),
        }}
      >
        {/* Countdown bar */}
        <div
          style={{
            width: "80%",
            height: sc(3),
            background: "rgba(255,255,255,0.2)",
            borderRadius: sc(2),
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct * 100}%`,
              background:
                pct > 0.6 ? "#22c55e" : pct > 0.3 ? "#f59e0b" : "#ef4444",
              transition: "width 0.1s linear, background 0.5s",
            }}
          />
        </div>

        <div
          style={{
            fontSize: sc(17),
            fontWeight: 700,
            color: "#fff",
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          {call.caller}
        </div>

        <div
          style={{ fontSize: sc(12), color: "#9ca3af", textAlign: "center" }}
        >
          {call.sub}
        </div>

        <div style={{ fontSize: sc(11), color: "#6b7280" }}>
          {(timeLeft / 1000).toFixed(1)}s
        </div>
      </div>

      {/* ── Avatar image on the dark circle ── */}
      <img
        src={`${import.meta.env.BASE_URL}sprites/${call.avatar}`}
        alt={call.caller}
        draggable={false}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "38%",
          height: "38%",
          objectFit: "contain",
          pointerEvents: "none",
        }}
      />

      {/* ── 掛斷：左邊紅圈 ── */}
      <button
        onPointerDown={(e) => {
          e.stopPropagation();
          onDecline(call.id);
        }}
        style={{
          position: "absolute",
          top: "77%",
          left: "30%",
          transform: "translate(-50%, -50%)",
          width: "22%",
          aspectRatio: "1",
          borderRadius: "50%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          touchAction: "manipulation",
          padding: 0,
        }}
      />

      {/* ── 接聽：右邊綠圈 ── */}
      <button
        onPointerDown={(e) => {
          e.stopPropagation();
          onAnswer(call.id);
        }}
        style={{
          position: "absolute",
          top: "77%",
          left: "70%",
          transform: "translate(-50%, -50%)",
          width: "22%",
          aspectRatio: "1",
          borderRadius: "50%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          touchAction: "manipulation",
          padding: 0,
        }}
      />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
interface GameCanvasProps {
  onBack: () => void;
}

export default function GameCanvas({ onBack }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gsRef = useRef<GameState>(initState(getBestForLevel(1)));
  const rafRef = useRef(0);
  const moveDirRef = useRef<-1 | 0 | 1>(0);
  const btnActiveRef = useRef(false);
  const exitConfirmRef = useRef(false);

  // React state — only for HTML overlays (phone calls), status & orientation
  const [calls, setCalls] = useState<PhoneCall[]>([]);
  const [gameStatus, setGameStatus] = useState<"idle" | "playing" | "gameover">(
    "idle",
  );
  const [portrait, setPortrait] = useState<boolean>(isPortraitViewport);
  const [vpW, setVpW] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 390,
  );
  const [vpH, setVpH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 700,
  );
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [scoreDisplay, setScoreDisplay] = useState(0);
  const [timeLeftDisplay, setTimeLeftDisplay] = useState(GAME_DURATION_MS);
  const [comboDisplay, setComboDisplay] = useState(0);
  const [maxComboDisplay, setMaxComboDisplay] = useState(0);
  const [fatDisplay, setFatDisplay] = useState(false);
  const [fatUntilDisplay, setFatUntilDisplay] = useState(0);
  const [dailySpecialDisplay, setDailySpecialDisplay] = useState<string[]>([]);

  // ── Preload meal images ────────────────────────────────────────────────────
  // ── Start / restart game ───────────────────────────────────────────────────
  const startGame = useCallback((char: CharacterId) => {
    const hi = getBestForLevel(1);
    const now = performance.now();
    gsRef.current = initState(hi, char);
    gsRef.current.status = "playing";
    gsRef.current.nextItemTime = now + 500;
    gsRef.current.nextCallTime = now + CALL_SPAWN_MS;
    gsRef.current.lastFrameTs = now;
    if (char === "shield")
      gsRef.current.nextShieldTime = now + SHIELD_RECHARGE_MS;
    setGameStatus("playing");
    setCalls([]);
  }, []);

  // ── Phone call action handlers ────────────────────────────────────────────
  const handleAnswer = useCallback((callId: number) => {
    moveDirRef.current = 0;
    const gs = gsRef.current;
    const call = gs.calls.find((c) => c.id === callId);
    if (!call || call.resolved) return;
    call.resolved = true;
    gs.callsDirty = true;

    if (call.type === "legit") {
      gs.score += SCORE_LEGIT_ANSWER;
      if (gs.character === "phone") {
        gs.score += 10;
        gs.phoneBoostUntil = performance.now() + PHONE_BOOST_MS;
      }
    } else {
      gs.frozen = true;
      gs.frozenUntil = performance.now() + FREEZE_MS;
      gs.frozenMsg = "可惡！被詐騙了！！";
    }
  }, []);

  const handleDecline = useCallback((callId: number) => {
    moveDirRef.current = 0;
    const gs = gsRef.current;
    const call = gs.calls.find((c) => c.id === callId);
    if (!call || call.resolved) return;
    call.resolved = true;
    gs.callsDirty = true;

    if (call.type === "scam") {
      if (gs.character === "phone")
        gs.phoneBoostUntil = performance.now() + PHONE_BOOST_MS;
    } else {
      gs.score += SCORE_LEGIT_MISS;
      gs.frozen = true;
      gs.frozenUntil = performance.now() + FREEZE_MS;
      gs.frozenMsg = `${call.caller}：竟敢掛我電話！？`;
    }
  }, []);

  // ── Game update logic (called each frame) ─────────────────────────────────
  const update = useCallback((gs: GameState, now: number, dt: number) => {
    const wasPlaying = gs.status === "playing";
    gs.elapsed += dt;

    // Countdown timer
    gs.timeLeft -= dt;
    if (gs.timeLeft <= 0) {
      gs.timeLeft = 0;
      gs.timeUp = true;
      gs.status = "gameover";
    }

    // Unfreeze
    if (gs.frozen && now >= gs.frozenUntil) {
      gs.frozen = false;
      gs.frozenMsg = null;
    }

    // Un-fat
    if (gs.fat && now >= gs.fatUntil) gs.fat = false;

    // Move player (if not frozen)
    const comboSpeedBonus = Math.min(
      Math.floor(gs.combo / 3) * 0.5,
      PLAYER_SPEED,
    );
    const speed = gs.fat
      ? Math.round(PLAYER_SPEED * 0.35)
      : Math.min(PLAYER_SPEED + comboSpeedBonus, PLAYER_SPEED * 2);
    if (!gs.frozen) {
      if (moveDirRef.current !== 0) {
        gs.playerX += moveDirRef.current * speed;
        gs.targetX = gs.playerX;
      } else {
        const dx = gs.targetX - gs.playerX;
        if (Math.abs(dx) > 1) {
          gs.playerX += Math.sign(dx) * Math.min(Math.abs(dx), speed);
        }
      }
    }
    // Clamp player
    gs.playerX = Math.max(0, Math.min(LW - PLAYER_W, gs.playerX));

    // Spawn falling items
    if (now >= gs.nextItemTime) {
      gs.nextItemTime = now + ITEM_SPAWN_MS - Math.min(gs.elapsed * 0.05, 600);
      gs.items.push({
        id: gs.idCounter++,
        x: rng(8, LW - ITEM_SIZE - 8),
        y: -ITEM_SIZE,
        mealFile: pick(MEAL_FILES),
        speed: 0.8 + Math.random() * 0.4 + gs.elapsed * 0.00006,
      });
    }

    // Move items & check collision
    const playerTop = LH - 60 - PLAYER_H;
    const playerLeft = gs.playerX;
    const playerRight = gs.playerX + PLAYER_W;

    gs.items = gs.items.filter((item) => {
      item.y += item.speed;

      // Off-screen
      if (item.y > LH) return false;

      // Collision with player (AABB)
      const itemRight = item.x + ITEM_SIZE;
      const itemBottom = item.y + ITEM_SIZE;
      if (
        item.x < playerRight &&
        itemRight > playerLeft &&
        item.y < playerTop + PLAYER_H &&
        itemBottom > playerTop
      ) {
        const mf = item.mealFile;
        if (gs.dailySpecial.includes(mf)) {
          // Correct special — bonus
          const boosted = gs.character === "phone" && now < gs.phoneBoostUntil;
          gs.score += boosted ? SCORE_SPECIAL + 10 : SCORE_SPECIAL;
          if (gs.character === "bento") {
            gs.comboCount++;
            if (gs.comboCount >= 3) gs.comboActive = true;
          }
          gs.combo++;
          if (gs.combo > gs.maxCombo) gs.maxCombo = gs.combo;
        } else {
          // Wrong meal — deduct 10 pts, fat & slow (shield can block)
          if (gs.character === "shield" && gs.shields > 0) {
            gs.shields--;
          } else {
            gs.score -= 30;
            gs.fat = true;
            gs.fatUntil = now + FAT_DURATION_MS;
            if (gs.character === "bento") {
              gs.comboCount = 0;
              gs.comboActive = false;
            }
            gs.combo = 0;
          }
        }
        if (gs.score > gs.hiScore) gs.hiScore = gs.score;
        return false;
      }
      return true;
    });

    // Shield recharge
    if (
      gs.character === "shield" &&
      gs.shields < MAX_SHIELDS &&
      gs.nextShieldTime > 0 &&
      now >= gs.nextShieldTime
    ) {
      gs.shields++;
      gs.nextShieldTime =
        gs.shields < MAX_SHIELDS ? now + SHIELD_RECHARGE_MS : Infinity;
    }

    // Spawn phone calls
    if (now >= gs.nextCallTime) {
      gs.nextCallTime = now + CALL_SPAWN_MS;
      const isLegit = Math.random() < 0.55;
      const callerList = isLegit ? LEGIT_CALLERS : SCAM_CALLERS;
      const callerInfo = pick(callerList);
      gs.calls.push({
        id: gs.idCounter++,
        side: Math.random() < 0.5 ? "left" : "right",
        type: isLegit ? "legit" : "scam",
        caller: callerInfo.name,
        sub: callerInfo.sub,
        avatar: callerInfo.avatar,
        spawnTime: now,
        resolved: false,
      });
      gs.callsDirty = true;
    }

    // Resolve timed-out calls
    gs.calls.forEach((call) => {
      if (call.resolved) return;
      const age = now - call.spawnTime;
      if (age >= CALL_TIMEOUT_MS) {
        call.resolved = true;
        gs.callsDirty = true;
        if (call.type === "legit") {
          // Missed legit call — penalty + freeze 3s
          gs.score += SCORE_LEGIT_MISS;
          gs.frozen = true;
          gs.frozenUntil = now + FREEZE_MS;
          gs.frozenMsg = `${call.caller}：竟敢掛我電話！？`;
        }
        // Scam timed out = scammer gave up, no penalty
      }
    });

    // Remove resolved calls after a tick
    const prevLen = gs.calls.length;
    gs.calls = gs.calls.filter((c) => !c.resolved);
    if (gs.calls.length !== prevLen) gs.callsDirty = true;

    // Record this play exactly once, the frame it transitions into gameover
    if (wasPlaying && gs.status === "gameover") {
      addRecord(1, gs.score);
      if (gs.score > gs.hiScore) gs.hiScore = gs.score;
    }
  }, []);

  // ── Render (canvas only) ───────────────────────────────────────────────────
  const render = useCallback(
    (ctx: CanvasRenderingContext2D, gs: GameState, now: number) => {
      ctx.save();
      ctx.scale(GS, GS);

      drawBackground(ctx);

      // Falling items — all use sprite images
      for (const item of gs.items) {
        const isSpecial = gs.dailySpecial.includes(item.mealFile);
        drawMeal(ctx, item.x, item.y, item.mealFile, isSpecial);
      }

      // Player
      const playerY = LH - 60 - PLAYER_H;
      drawPlayer(ctx, gs.playerX, playerY, gs.fat, gs.frozen);

      // Fat indicator above player
      if (gs.fat && !gs.frozen) {
        const remaining = Math.max(0, gs.fatUntil - now);
        const label = `胖了！${(remaining / 1000).toFixed(1)}s`;
        const cx = Math.round(gs.playerX + PLAYER_W / 2);

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.font = "bold 11px 'Cubic11', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const tw = Math.ceil(ctx.measureText(label).width);
        const padX = 8;
        const bw = tw + padX * 2;
        const bh = 22;
        const tailH = 6;
        const bx = Math.round(cx - bw / 2);
        const by = playerY - tailH - bh;
        const FILL = "#fef3c7";
        const BD = "#1c1400";

        // Box fill
        ctx.fillStyle = FILL;
        ctx.fillRect(bx + 2, by + 2, bw - 4, bh - 4);

        // 2px pixel border
        ctx.fillStyle = BD;
        ctx.fillRect(bx + 2, by, bw - 4, 2); // top
        ctx.fillRect(bx + 2, by + bh - 2, bw - 4, 2); // bottom
        ctx.fillRect(bx, by + 2, 2, bh - 4); // left
        ctx.fillRect(bx + bw - 2, by + 2, 2, bh - 4); // right
        // 2×2 corner pixels (pixel-art diagonal cut)
        ctx.fillRect(bx + 2, by + 2, 2, 2);
        ctx.fillRect(bx + bw - 4, by + 2, 2, 2);
        ctx.fillRect(bx + 2, by + bh - 4, 2, 2);
        ctx.fillRect(bx + bw - 4, by + bh - 4, 2, 2);

        // Inner highlight (top-left rim for depth)
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillRect(bx + 4, by + 2, bw - 8, 1);
        ctx.fillRect(bx + 2, by + 4, 1, bh - 6);

        // Tail: staircase pointing down
        const tx = cx;
        const ty = by + bh;
        ctx.fillStyle = BD;
        ctx.fillRect(tx - 3, ty + 0, 6, 2); // row1 border
        ctx.fillRect(tx - 2, ty + 2, 4, 2); // row2 border
        ctx.fillRect(tx - 1, ty + 4, 2, 2); // tip
        ctx.fillStyle = FILL;
        ctx.fillRect(tx - 2, ty + 0, 4, 2); // row1 fill
        ctx.fillRect(tx - 1, ty + 2, 2, 2); // row2 fill

        // Text
        ctx.fillStyle = BD;
        ctx.fillText(label, cx, by + bh / 2 + 1);

        ctx.restore();
      }

      // Freeze overlay
      if (gs.frozen) {
        drawFreezeOverlay(
          ctx,
          gs.frozenUntil,
          now,
          gs.playerX,
          playerY,
          gs.frozenMsg,
        );
      }

      // Idle / game-over screens
      if (gs.status === "idle") drawIdleScreen(ctx);
      if (gs.status === "gameover")
        drawGameOver(ctx, gs.score, gs.hiScore, gs.timeUp);

      ctx.restore();
    },
    [],
  );

  // ── Game loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let statusSent = gsRef.current.status;
    let lastHudSync = 0;

    const loop = (now: number) => {
      const gs = gsRef.current;
      const dt = Math.min(now - gs.lastFrameTs, 50); // cap at 50ms (tab focus resume)
      gs.lastFrameTs = now;

      if (gs.status === "playing" && !exitConfirmRef.current) {
        update(gs, now, dt);
      }

      render(ctx, gs, now);

      // Sync to React only on changes
      if (gs.callsDirty) {
        gs.callsDirty = false;
        setCalls([...gs.calls]);
      }
      if (gs.status !== statusSent) {
        statusSent = gs.status;
        setGameStatus(gs.status);
        if (gs.status === "gameover") setCalls([]);
      }

      // Sync HUD display every ~100ms to avoid excessive re-renders
      if (now - lastHudSync > 100) {
        lastHudSync = now;
        setScoreDisplay(gs.score);
        setTimeLeftDisplay(gs.timeLeft);
        setComboDisplay(gs.combo);
        setMaxComboDisplay(gs.maxCombo);
        setFatDisplay(gs.fat);
        setFatUntilDisplay(gs.fatUntil);
        setDailySpecialDisplay(gs.dailySpecial);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [update, render]);

  // ── Orientation / resize ──────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      const p = isPortraitViewport();
      CW = window.innerWidth;
      CH = window.innerHeight;
      LW = p ? 390 : 720;
      GS = p ? CW / LW : Math.min(CW / LW, CH / (p ? 700 : 480));
      LH = Math.round(CH / GS);
      if (canvasRef.current) {
        canvasRef.current.width = CW;
        canvasRef.current.height = CH;
      }
      const gs = gsRef.current;
      gs.playerX = Math.max(0, Math.min(LW - PLAYER_W, gs.playerX));
      gs.targetX = gs.playerX;
      setPortrait(p);
      setVpW(window.innerWidth);
      setVpH(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Global pointer-up: reset ONLY when a d-pad button was held ───────────
  useEffect(() => {
    const reset = () => {
      if (btnActiveRef.current) {
        btnActiveRef.current = false;
        moveDirRef.current = 0;
      }
    };
    document.addEventListener("pointerup", reset);
    document.addEventListener("pointercancel", reset);
    return () => {
      document.removeEventListener("pointerup", reset);
      document.removeEventListener("pointercancel", reset);
    };
  }, []);

  // ── Keyboard controls ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") moveDirRef.current = -1;
      if (e.key === "ArrowRight") moveDirRef.current = 1;
      if (e.key === "z" || e.key === "Z") {
        const call = gsRef.current.calls.find((c) => !c.resolved);
        if (call) handleDecline(call.id);
      }
      if (e.key === "x" || e.key === "X") {
        const call = gsRef.current.calls.find((c) => !c.resolved);
        if (call) handleAnswer(call.id);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight")
        moveDirRef.current = 0;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // ── Canvas click / tap → start game immediately ──────────────────────────
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const gs = gsRef.current;
      if (gs.status === "idle" || gs.status === "gameover") {
        e.preventDefault();
        startGame("bento");
      }
    },
    [startGame],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

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

  const sec = Math.ceil(timeLeftDisplay / 1000);
  const timeStr = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const missionPct = Math.min(Math.max(scoreDisplay, 0) / MISSION_TARGET, 1);
  const comboColor =
    comboDisplay < 5
      ? "#22c55e"
      : comboDisplay < 10
        ? "#3b82f6"
        : comboDisplay < 20
          ? "#a855f7"
          : "#f59e0b";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        overflow: "hidden",
      }}
    >
      {/* Background video */}
      <video
        src={game1BgSrc}
        autoPlay
        loop
        muted
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

      <style>{`
        @keyframes screenShake {
          0%   { transform: translate(0,0); }
          15%  { transform: translate(-4px,3px); }
          30%  { transform: translate(4px,-3px); }
          45%  { transform: translate(-3px,-4px); }
          60%  { transform: translate(3px,4px); }
          75%  { transform: translate(-4px,2px); }
          90%  { transform: translate(4px,-2px); }
          100% { transform: translate(0,0); }
        }
        @keyframes phoneSlideIn {
          from { opacity: 0; transform: translateY(-50%) scale(0.85); }
          to   { opacity: 1; transform: translateY(-50%) scale(1); }
        }
        @keyframes phonePulse {
          0%,100% { box-shadow: 0 0 14px rgba(59,130,246,0.6); }
          50%     { box-shadow: 0 0 28px rgba(59,130,246,1); }
        }
        @keyframes comboPulse {
          0%,100% { transform: scale(1); }
          50%     { transform: scale(1.18); }
        }
        @keyframes blink {
          0%,100% { opacity: 1; }
          50%     { opacity: 0.4; }
        }
      `}</style>

      {/* Shake wrapper */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          animation:
            calls.length > 0 && !showExitConfirm
              ? "screenShake 0.08s infinite"
              : "none",
        }}
      >
        {/* Inner game area */}
        <div
          style={{
            position: "absolute",
            inset: 0,
          }}
        >
          <canvas
            ref={canvasRef}
            width={vpW}
            height={vpH}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              touchAction: "none",
              cursor: "default",
            }}
            onPointerDown={onCanvasPointerDown}
          />

          {/* ═══════════════ HUD OVERLAY (playing only) */}
          {gameStatus === "playing" && (
            <>
              {/* ── TOP LEFT: SCORE + TIME ─────────── */}
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
                    minWidth: s(portrait ? 96 : 108),
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
                      fontSize: s(portrait ? 20 : 22),
                      fontWeight: 700,
                      color: "#f0c040",
                      letterSpacing: 1,
                    }}
                  >
                    {String(Math.max(0, scoreDisplay)).padStart(5, "0")}
                  </div>
                </div>

                <div
                  style={{
                    ...panelBase,
                    padding: `${s(4)}px ${s(10)}px ${s(5)}px`,
                    minWidth: s(portrait ? 78 : 88),
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
                      fontSize: s(portrait ? 20 : 22),
                      fontWeight: 700,
                      color: timeLeftDisplay < 10000 ? "#f87171" : "#fff",
                      letterSpacing: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: s(4),
                      animation:
                        timeLeftDisplay < 10000
                          ? "blink 0.8s infinite"
                          : "none",
                    }}
                  >
                    <span style={{ fontSize: s(13) }}>⏱</span>
                    {Math.ceil(timeLeftDisplay / 1000)}
                  </div>
                </div>
              </div>

              {/* ── TOP CENTER: 今日特餐 ───────────── */}
              <div
                style={{
                  position: "absolute",
                  top: s(8),
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 40,
                  ...panelBase,
                  padding: `${s(6)}px ${s(16)}px ${s(8)}px`,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    fontSize: s(12),
                    color: "#f0c040",
                    letterSpacing: s(1),
                    fontWeight: 700,
                    marginBottom: s(5),
                  }}
                >
                  今日特餐
                </div>
                <div
                  style={{ display: "flex", gap: s(8), alignItems: "center" }}
                >
                  {dailySpecialDisplay.map((sf) => {
                    const img = IMG_CACHE.get(sf);
                    return img ? (
                      <div
                        key={sf}
                        style={{
                          width: s(44),
                          height: s(44),
                          borderRadius: s(8),
                          border: "2px solid #f0c040",
                          background: "rgba(240,192,64,0.12)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                        }}
                      >
                        <img
                          src={img.src}
                          alt=""
                          style={{
                            width: s(36),
                            height: s(36),
                            imageRendering: "pixelated",
                          }}
                        />
                      </div>
                    ) : null;
                  })}
                </div>
              </div>

              {/* ── TOP RIGHT: MISSION + back button ── */}
              <div
                style={{
                  position: "absolute",
                  top: s(8),
                  right: s(8),
                  display: "flex",
                  gap: s(6),
                  alignItems: "flex-start",
                  zIndex: 40,
                }}
              >
                <div
                  style={{
                    ...panelBase,
                    padding: `${s(4)}px ${s(10)}px ${s(6)}px`,
                    width: s(portrait ? 148 : 168),
                  }}
                >
                  <div
                    style={{
                      fontSize: s(9),
                      color: "#f0c040",
                      letterSpacing: s(2),
                      fontWeight: 700,
                      marginBottom: s(2),
                    }}
                  >
                    MISSION
                  </div>
                  <div
                    style={{
                      fontSize: s(portrait ? 9 : 10),
                      color: "#e2e8f0",
                      marginBottom: s(5),
                      whiteSpace: "nowrap",
                    }}
                  >
                    下班前達到 {MISSION_TARGET} 分！
                  </div>
                  <div
                    style={{
                      height: s(8),
                      background: "rgba(255,255,255,0.1)",
                      borderRadius: s(4),
                      overflow: "hidden",
                      marginBottom: s(3),
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${missionPct * 100}%`,
                        background:
                          missionPct >= 1
                            ? "#4ade80"
                            : "linear-gradient(90deg,#f0c040,#fbbf24)",
                        borderRadius: s(4),
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: s(9),
                      color: "#9ca3af",
                      textAlign: "right",
                    }}
                  >
                    {Math.max(0, scoreDisplay)}/{MISSION_TARGET}
                  </div>
                </div>

                <button
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    exitConfirmRef.current = true;
                    setShowExitConfirm(true);
                  }}
                  style={{
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
                    flexShrink: 0,
                  }}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}sprites/back.png`}
                    alt="返回"
                    draggable={false}
                    style={{
                      width: s(60),
                      height: s(60),
                      objectFit: "contain",
                    }}
                  />
                </button>
              </div>

              {/* ── BOTTOM ROW: COMBO | D-pad | STATUS ─ */}
              <div
                style={{
                  position: "absolute",
                  bottom: s(8),
                  left: s(8),
                  right: s(8),
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-end",
                  zIndex: 30,
                  pointerEvents: "none",
                }}
              >
                {/* COMBO */}
                <div
                  style={{
                    ...panelBase,
                    padding: `${s(6)}px ${s(10)}px ${s(8)}px`,
                    width: s(portrait ? 92 : 108),
                    pointerEvents: "auto",
                  }}
                >
                  <div
                    style={{
                      fontSize: s(9),
                      color: "#f0c040",
                      letterSpacing: s(2),
                      fontWeight: 700,
                      marginBottom: s(2),
                    }}
                  >
                    COMBO
                  </div>
                  <div
                    style={{
                      color: comboDisplay === 0 ? "#6b7280" : comboColor,
                      fontSize: s(portrait ? 24 : 28),
                      fontWeight: 700,
                      letterSpacing: 1,
                      lineHeight: 1,
                      marginBottom: s(4),
                      display: "inline-block",
                      animation:
                        comboDisplay > 0
                          ? "comboPulse 0.4s ease-in-out"
                          : "none",
                    }}
                  >
                    {String(comboDisplay).padStart(2, " ")}
                  </div>
                  <div
                    style={{
                      height: s(5),
                      borderRadius: s(3),
                      background: "rgba(255,255,255,0.1)",
                      overflow: "hidden",
                      marginBottom: s(3),
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min((comboDisplay / 30) * 100, 100)}%`,
                        background:
                          "linear-gradient(90deg,#22c55e,#3b82f6,#a855f7,#f59e0b)",
                        borderRadius: s(3),
                        transition: "width 0.2s ease",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: s(9), color: "#6b7280" }}>
                    最高 {maxComboDisplay}
                  </div>
                </div>

                {/* D-pad + Phone buttons */}
                <div
                  style={{
                    display: "flex",
                    gap: s(portrait ? 8 : 10),
                    pointerEvents: "auto",
                    alignItems: "center",
                  }}
                >
                  {/* Left / Right direction buttons */}
                  {([-1, 1] as const).map((dir) => (
                    <button
                      key={dir}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        btnActiveRef.current = true;
                        moveDirRef.current = dir;
                      }}
                      onPointerUp={(e) => {
                        e.stopPropagation();
                        btnActiveRef.current = false;
                        moveDirRef.current = 0;
                      }}
                      onPointerLeave={(e) => {
                        e.stopPropagation();
                        btnActiveRef.current = false;
                        moveDirRef.current = 0;
                      }}
                      onPointerCancel={(e) => {
                        e.stopPropagation();
                        btnActiveRef.current = false;
                        moveDirRef.current = 0;
                      }}
                      style={{
                        width: s(portrait ? 74 : 68),
                        height: s(portrait ? 74 : 68),
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        touchAction: "none",
                        userSelect: "none",
                      }}
                    >
                      <img
                        src={`${import.meta.env.BASE_URL}sprites/${dir === -1 ? "left.png" : "right.png"}`}
                        alt={dir === -1 ? "左" : "右"}
                        draggable={false}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                        }}
                      />
                    </button>
                  ))}

                  {/* Z (掛) / X (接) phone buttons */}
                  {(["Z.png", "X.png"] as const).map((img) => {
                    const isDecline = img === "Z.png";
                    return (
                      <button
                        key={img}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const c = gsRef.current.calls.find(
                            (c) => !c.resolved,
                          );
                          if (c)
                            isDecline
                              ? handleDecline(c.id)
                              : handleAnswer(c.id);
                        }}
                        style={{
                          width: s(portrait ? 74 : 68),
                          height: s(portrait ? 74 : 68),
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          touchAction: "manipulation",
                        }}
                      >
                        <img
                          src={`${import.meta.env.BASE_URL}sprites/${img}`}
                          alt={isDecline ? "掛" : "接"}
                          draggable={false}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                          }}
                        />
                      </button>
                    );
                  })}
                </div>

                {/* STATUS */}
                <div
                  style={{
                    ...panelBase,
                    padding: `${s(6)}px ${s(10)}px ${s(8)}px`,
                    width: s(portrait ? 128 : 150),
                    pointerEvents: "auto",
                  }}
                >
                  <div
                    style={{
                      fontSize: s(9),
                      color: "#f0c040",
                      letterSpacing: s(2),
                      fontWeight: 700,
                      marginBottom: s(5),
                    }}
                  >
                    STATUS
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: s(6),
                      marginBottom: s(7),
                    }}
                  >
                    <img
                      src={`${import.meta.env.BASE_URL}sprites/${fatDisplay ? "XL.png" : "M.png"}`}
                      alt={fatDisplay ? "XL" : "M"}
                      style={{
                        width: s(28),
                        height: s(28),
                        objectFit: "contain",
                        verticalAlign: "middle",
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: s(9),
                          color: "#cbd5e1",
                          marginBottom: s(2),
                        }}
                      >
                        體重
                      </div>
                      <div
                        style={{
                          height: s(6),
                          background: "rgba(255,255,255,0.1)",
                          borderRadius: s(3),
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: fatDisplay
                              ? `${Math.min(Math.max(0, (fatUntilDisplay - performance.now()) / FAT_DURATION_MS) * 100, 100)}%`
                              : "28%",
                            background: fatDisplay ? "#ef4444" : "#22c55e",
                            borderRadius: s(3),
                            transition: "background 0.5s",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div
                      style={{
                        background: "rgba(30,60,130,0.7)",
                        borderRadius: s(5),
                        padding: `${s(2)}px ${s(6)}px`,
                        display: "flex",
                        alignItems: "center",
                        gap: s(4),
                      }}
                    >
                      <span style={{ fontSize: s(10) }}>⏱</span>
                      <span
                        style={{
                          fontSize: s(12),
                          fontWeight: 700,
                          color:
                            timeLeftDisplay < 10000 ? "#f87171" : "#f0c040",
                        }}
                      >
                        {timeStr}
                      </span>
                    </div>
                    {fatDisplay && (
                      <div
                        style={{
                          fontSize: s(9),
                          color: "#f87171",
                          fontWeight: 700,
                          animation: "blink 0.6s infinite",
                        }}
                      >
                        {(
                          Math.max(0, fatUntilDisplay - performance.now()) /
                          1000
                        ).toFixed(1)}
                        s
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Phone call overlays */}
              {calls.map((call) => (
                <CallOverlay
                  key={call.id}
                  call={call}
                  portrait={portrait}
                  uiScale={uiScale}
                  onAnswer={handleAnswer}
                  onDecline={handleDecline}
                />
              ))}

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
                    {/* Body */}
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

                      <div
                        style={{
                          display: "flex",
                          gap: s(10),
                          marginTop: s(16),
                        }}
                      >
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
            </>
          )}

          {/* Back button — idle / gameover */}
          {gameStatus !== "playing" && (
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
                background:
                  "linear-gradient(135deg,rgb(30,58,138),rgb(37,99,235))",
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
        </div>
      </div>
    </div>
  );
}
