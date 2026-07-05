import { useRef, useEffect, useState, useCallback } from "react";
import { addRecord, getBestForLevel } from "./leaderboard";
import game1BgSrc from "./assets/game1_bg.png";

// ─── Canvas dimensions (mutable — updated on orientation change) ─────────────
const isPortraitViewport = () =>
  typeof window !== "undefined" && window.innerWidth < window.innerHeight;

let CW = isPortraitViewport() ? 390 : 720;
let CH = isPortraitViewport() ? 700 : 480;

// ─── Game tuning ─────────────────────────────────────────────────────────────
const PLAYER_W = 54;
const PLAYER_H = 64;
const ITEM_SIZE = 50;
const ITEM_SPAWN_MS = 1200;
const CALL_SPAWN_MS = 10_000;
const CALL_TIMEOUT_MS = 3000; // seconds before call auto-expires
const FREEZE_MS = 2000; // freeze duration for any mistake
const GAME_DURATION_MS = 60_000; // 1-minute countdown
const PLAYER_SPEED = 8; // px per frame at 60fps
const SCORE_LEGIT_ANSWER = 20; // bonus for correctly answering legit call
const SCORE_LEGIT_MISS = -50; // missed legit call penalty
const GAMEOVER_SCORE = -100; // game over threshold
const SCORE_SPECIAL = 25; // bonus for catching today's special
const FAT_DURATION_MS = 3000; // wrong-meal fat/slow duration
const MISSION_TARGET = 500; // score target for the daily mission

// ─── Meal catalogue ───────────────────────────────────────────────────────────
const MEAL_FILES = [
  "fried-chicken-bucket.png",
  "fried-chicken.png",
  "hamburger.png",
  "hot-dog.png",
  "japanese-bento.png",
  "pizza.png",
  "ramen.png",
  "salad.png",
  "spicy-hot-pot.png",
  "takoyaki.png",
];

// Daily special is drawn from this subset (excludes salad and spicy-hot-pot)
const SPECIAL_MEAL_FILES = MEAL_FILES.filter(
  (f) => f !== "salad.png" && f !== "spicy-hot-pot.png",
);

// Module-level image cache — starts loading immediately when the module is imported
const IMG_CACHE = new Map<string, HTMLImageElement>();
MEAL_FILES.forEach((file) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/${file}`;
  IMG_CACHE.set(file, img);
});

// ─── Character system ─────────────────────────────────────────────────────────
const SHIELD_RECHARGE_MS = 15_000;
const PHONE_BOOST_MS = 5_000;
const MAX_SHIELDS = 2;

type CharacterId = "bento" | "shield" | "phone";

const LEGIT_CALLERS = [
  { name: "老闆", sub: "週報發了嗎？" },
  { name: "PM 緊急", sub: "需求又改了！" },
  { name: "董事長", sub: "你在哪？快接！" },
  { name: "大客戶", sub: "緊急問題！" },
  { name: "主管", sub: "現在有空嗎？" },
  { name: "人資", sub: "面談時間確認" },
];

const SCAM_CALLERS = [
  { name: "股票飆股達人", sub: "年報酬 300%！" },
  { name: "低利房貸免審", sub: "今天就撥款！" },
  { name: "恭喜！您中獎了", sub: "領取百萬大獎！" },
  { name: "外國投資機構", sub: "保證獲利！" },
  { name: "法院傳票通知", sub: "立即接聽！（詐騙）" },
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
  frozen: boolean,
  fat: boolean,
) {
  const fatScale = fat ? 1.45 : 1;
  const pw = PLAYER_W * fatScale;
  const ox = (pw - PLAYER_W) / 2; // extra pixels on each side
  const cx = x + PLAYER_W / 2;
  const hr = fat ? 22 : 18; // head radius

  // Body
  ctx.fillStyle = frozen ? "#7b9ec9" : fat ? "#c8701a" : "#4a90e2";
  drawRoundRect(ctx, x - ox, y + 20, pw, PLAYER_H - 20, 8);
  ctx.fill();

  // Head
  ctx.fillStyle = frozen ? "#c9a87b" : fat ? "#f5a623" : "#f5c97a";
  ctx.beginPath();
  ctx.arc(cx, y + hr, hr, 0, Math.PI * 2);
  ctx.fill();

  // Eyes
  ctx.fillStyle = "#333";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  if (frozen) {
    ctx.fillText("x  x", cx, y + hr + 2);
  } else if (fat) {
    ctx.fillText("^ ^", cx, y + hr);
  } else {
    ctx.beginPath();
    ctx.arc(cx - 6, y + 14, 3, 0, Math.PI * 2);
    ctx.arc(cx + 6, y + 14, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mouth
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (frozen) {
    ctx.moveTo(cx - 6, y + 24);
    ctx.lineTo(cx + 6, y + 24);
  } else {
    ctx.arc(cx, y + hr + 4, fat ? 10 : 6, 0, Math.PI);
  }
  ctx.stroke();

  // Lunch box in hands (wider when fat)
  ctx.fillStyle = "#f0f0f0";
  drawRoundRect(ctx, x - ox + 8, y + 44, pw - 16, 16, 4);
  ctx.fill();
  ctx.strokeStyle = "#aaa";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (frozen) {
    ctx.fillStyle = "rgba(100,180,255,0.4)";
    drawRoundRect(ctx, x - 2, y - 2, PLAYER_W + 4, PLAYER_H + 4, 10);
    ctx.fill();
  }
}

function drawMeal(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  file: string,
) {
  const img = IMG_CACHE.get(file);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, x, y, ITEM_SIZE, ITEM_SIZE);
  } else {
    ctx.fillStyle = "#555";
    drawRoundRect(ctx, x, y, ITEM_SIZE, ITEM_SIZE, 6);
    ctx.fill();
  }
}

function drawBackground(ctx: CanvasRenderingContext2D) {
  // The background art is a real DOM <img> behind the canvas now (crisp at native
  // resolution instead of being rasterized into the small canvas buffer and
  // stretched blurry) — the canvas itself just needs to stay transparent.
  ctx.clearRect(0, 0, CW, CH);
}

function drawFreezeOverlay(
  ctx: CanvasRenderingContext2D,
  msg: string | null,
  frozenUntil: number,
  now: number,
) {
  if (!msg) return;
  const remaining = Math.max(0, frozenUntil - now);
  ctx.fillStyle = "rgba(20,60,120,0.72)";
  ctx.fillRect(0, CH / 2 - 80, CW, 160);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("📵 定身中！", CW / 2, CH / 2 - 40);

  ctx.font = "15px sans-serif";
  ctx.fillStyle = "#aee";

  // Word-wrap the message
  const words = msg.split("");
  let line = "";
  let lineY = CH / 2 - 10;
  for (const ch of words) {
    if (ctx.measureText(line + ch).width > CW - 40) {
      ctx.fillText(line, CW / 2, lineY);
      line = ch;
      lineY += 22;
    } else {
      line += ch;
    }
  }
  ctx.fillText(line, CW / 2, lineY);

  ctx.fillStyle = "#f0c040";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText(
    `解凍倒數：${(remaining / 1000).toFixed(1)}s`,
    CW / 2,
    CH / 2 + 60,
  );
}

function drawIdleScreen(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.fillRect(0, 0, CW, CH);

  const cx = CW / 2;
  const top = CH / 2 - 130;

  // Title
  ctx.textAlign = "center";
  ctx.fillStyle = "#f0c040";
  ctx.font = "bold 32px sans-serif";
  ctx.fillText("🍱 便當接接樂", cx, top);

  // Subtitle
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "15px sans-serif";
  ctx.fillText("60 秒內接住螢幕上方指定的特餐便當！", cx, top + 38);

  // Rule rows
  const rules: [string, string][] = [
    ["✅ 接對特餐", "+25 分"],
    ["❌ 接錯食物", "-10 分，變胖速度變慢"],
    ["📞 工作來電", "需接聽（Z / 點綠色按鈕）"],
    ["🚨 詐騙來電", "需掛斷（X / 點紅色按鈕）"],
    ["😱 接錯電話", "被耽誤 2 秒，無法移動"],
  ];

  const rowH = 24;
  const rulesTop = top + 68;
  rules.forEach(([label, desc], i) => {
    const y = rulesTop + i * rowH;
    ctx.font = "bold 13px sans-serif";
    ctx.fillStyle = "#f0c040";
    ctx.textAlign = "right";
    ctx.fillText(label, cx - 4, y);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#e2e8f0";
    ctx.textAlign = "left";
    ctx.fillText(desc, cx + 6, y);
  });

  // Start prompt
  ctx.textAlign = "center";
  ctx.fillStyle = "#4ade80";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText("點擊畫面開始遊戲", cx, rulesTop + rules.length * rowH + 28);
}

function drawGameOver(
  ctx: CanvasRenderingContext2D,
  score: number,
  hiScore: number,
  timeUp: boolean,
) {
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, 0, CW, CH);

  ctx.textAlign = "center";
  ctx.fillStyle = timeUp ? "#f0c040" : "#e74c3c";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(timeUp ? "⏰ 時間到！" : "GAME OVER", CW / 2, CH / 2 - 80);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText(`最終分數：${score}`, CW / 2, CH / 2 - 30);

  ctx.fillStyle = "#f0c040";
  ctx.font = "20px sans-serif";
  ctx.fillText(`最高分：${hiScore}`, CW / 2, CH / 2 + 10);

  ctx.fillStyle = "#4ade80";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText("點擊畫面重新開始", CW / 2, CH / 2 + 70);
}

// ─── Initial state factory ────────────────────────────────────────────────────
function initState(hiScore = 0, character: CharacterId = "bento"): GameState {
  return {
    status: "idle",
    score: 0,
    hiScore,
    playerX: CW / 2 - PLAYER_W / 2,
    targetX: CW / 2 - PLAYER_W / 2,
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
  onAnswer: (id: number) => void;
  onDecline: (id: number) => void;
}

function CallOverlay({ call, portrait, onAnswer, onDecline }: CallOverlayProps) {
  const [timeLeft, setTimeLeft] = useState(CALL_TIMEOUT_MS);

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = CALL_TIMEOUT_MS - (performance.now() - call.spawnTime);
      setTimeLeft(Math.max(0, remaining));
    }, 100);
    return () => clearInterval(interval);
  }, [call.spawnTime]);

  const isLegit = call.type === "legit";
  const isLeft = call.side === "left";
  const pct = timeLeft / CALL_TIMEOUT_MS;

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        ...(isLeft ? { left: 8 } : { right: 8 }),
        transform: "translateY(-50%)",
        width: portrait ? 142 : 130,
        background: "#111827",
        borderRadius: 22,
        border: "3px solid #374151",
        boxShadow: "0 8px 32px rgba(0,0,0,0.85)",
        overflow: "hidden",
        fontFamily: "sans-serif",
        zIndex: 20,
        userSelect: "none",
        animation: "phoneSlideIn 0.3s ease-out",
      }}
    >
      {/* Countdown bar at top of phone */}
      <div style={{ height: 4, background: "#1f2937" }}>
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

      {/* Phone screen */}
      <div
        style={{
          padding: "12px 12px 10px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: isLegit
            ? "linear-gradient(180deg,#0f172a 0%,#1e3a5f 80%)"
            : "linear-gradient(180deg,#0f172a 0%,#3f0f0f 80%)",
        }}
      >
        {/* Caller avatar */}
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            background: isLegit
              ? "linear-gradient(135deg,#1e40af,#3b82f6)"
              : "linear-gradient(135deg,#991b1b,#ef4444)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 24,
            marginBottom: 6,
            border: `2px solid ${isLegit ? "#60a5fa" : "#f87171"}`,
            boxShadow: `0 0 14px ${isLegit ? "rgba(59,130,246,0.6)" : "rgba(239,68,68,0.6)"}`,
            animation: "phonePulse 1s ease-in-out infinite",
          }}
        >
          {isLegit ? "👔" : "🚨"}
        </div>

        <div
          style={{
            fontSize: 9,
            color: isLegit ? "#93c5fd" : "#fca5a5",
            letterSpacing: 1,
            marginBottom: 3,
            textTransform: "uppercase" as const,
          }}
        >
          {isLegit ? "來電中..." : "⚠ 疑似詐騙"}
        </div>

        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#fff",
            textAlign: "center",
            marginBottom: 2,
          }}
        >
          {call.caller}
        </div>

        <div
          style={{
            fontSize: 9,
            color: "#9ca3af",
            textAlign: "center",
            marginBottom: 6,
          }}
        >
          {call.sub}
        </div>

        <div
          style={{
            fontSize: 9,
            color: isLegit ? "#fbbf24" : "#f87171",
            fontWeight: 700,
            marginBottom: 10,
          }}
        >
          {isLegit ? "⚠️ 必須接聽！" : "⚠️ 必須掛斷！"}
        </div>

        {/* Decline left, Accept right */}
        <div style={{ display: "flex", gap: 18, marginBottom: 4 }}>
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              onDecline(call.id);
            }}
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "linear-gradient(135deg,#dc2626,#ef4444)",
              border: "2px solid #fecaca",
              boxShadow: "0 4px 12px rgba(239,68,68,0.5)",
              cursor: "pointer",
              touchAction: "manipulation",
              fontSize: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            📵
          </button>
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              onAnswer(call.id);
            }}
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "linear-gradient(135deg,#16a34a,#22c55e)",
              border: "2px solid #bbf7d0",
              boxShadow: "0 4px 12px rgba(34,197,94,0.5)",
              cursor: "pointer",
              touchAction: "manipulation",
              fontSize: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            📞
          </button>
        </div>

        <div style={{ fontSize: 9, color: "#6b7280" }}>
          {(timeLeft / 1000).toFixed(1)}s
        </div>
      </div>
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
      gs.frozenMsg = "你接了詐騙電話！😱 小心陌生來電！";
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
      gs.frozenMsg = "老闆電話沒接！😰 被念了 3 秒！";
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
    gs.playerX = Math.max(0, Math.min(CW - PLAYER_W, gs.playerX));

    // Spawn falling items
    if (now >= gs.nextItemTime) {
      gs.nextItemTime = now + ITEM_SPAWN_MS - Math.min(gs.elapsed * 0.05, 600);
      gs.items.push({
        id: gs.idCounter++,
        x: rng(8, CW - ITEM_SIZE - 8),
        y: -ITEM_SIZE,
        mealFile: pick(MEAL_FILES),
        speed: 1.3 + Math.random() * 0.9 + gs.elapsed * 0.0001,
      });
    }

    // Move items & check collision
    const playerTop = CH - 60 - PLAYER_H;
    const playerLeft = gs.playerX;
    const playerRight = gs.playerX + PLAYER_W;

    gs.items = gs.items.filter((item) => {
      item.y += item.speed;

      // Off-screen
      if (item.y > CH) return false;

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
            gs.score -= 10;
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
          gs.frozenMsg = "老闆電話漏接了！😰 被念了 3 秒！";
        }
        // Scam timed out = scammer gave up, no penalty
      }
    });

    // Remove resolved calls after a tick
    const prevLen = gs.calls.length;
    gs.calls = gs.calls.filter((c) => !c.resolved);
    if (gs.calls.length !== prevLen) gs.callsDirty = true;

    // Game over condition
    if (gs.score <= GAMEOVER_SCORE) {
      gs.status = "gameover";
    }

    // Record this play exactly once, the frame it transitions into gameover
    if (wasPlaying && gs.status === "gameover") {
      addRecord(1, gs.score);
      if (gs.score > gs.hiScore) gs.hiScore = gs.score;
    }
  }, []);

  // ── Render (canvas only) ───────────────────────────────────────────────────
  const render = useCallback(
    (ctx: CanvasRenderingContext2D, gs: GameState, now: number) => {
      drawBackground(ctx);

      // Falling items — all use sprite images
      for (const item of gs.items) {
        drawMeal(ctx, item.x, item.y, item.mealFile);
      }

      // Player
      const playerY = CH - 60 - PLAYER_H;
      drawPlayer(ctx, gs.playerX, playerY, gs.frozen, gs.fat);

      // Fat indicator above player
      if (gs.fat && !gs.frozen) {
        const remaining = Math.max(0, gs.fatUntil - now);
        ctx.fillStyle = "rgba(180,80,0,0.88)";
        drawRoundRect(ctx, gs.playerX - 10, playerY - 24, PLAYER_W + 20, 20, 6);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `🍔 胖了！${(remaining / 1000).toFixed(1)}s`,
          gs.playerX + PLAYER_W / 2,
          playerY - 9,
        );
      }

      // Freeze overlay
      if (gs.frozen) {
        drawFreezeOverlay(ctx, gs.frozenMsg, gs.frozenUntil, now);
      }

      // Idle / game-over screens
      if (gs.status === "idle") drawIdleScreen(ctx);
      if (gs.status === "gameover")
        drawGameOver(ctx, gs.score, gs.hiScore, gs.timeUp);
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

      if (gs.status === "playing") {
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
        // gameover shows the canvas gameover screen; React state stays 'playing'
        // until the player taps to restart
        if (gs.status !== "gameover") setGameStatus(gs.status);
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
      CW = p ? 390 : 720;
      CH = p ? 700 : 480;
      if (canvasRef.current) {
        canvasRef.current.width = CW;
        canvasRef.current.height = CH;
      }
      const gs = gsRef.current;
      gs.playerX = Math.max(0, Math.min(CW - PLAYER_W, gs.playerX));
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
        if (call) handleAnswer(call.id);
      }
      if (e.key === "x" || e.key === "X") {
        const call = gsRef.current.calls.find((c) => !c.resolved);
        if (call) handleDecline(call.id);
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
  const logicalW = portrait ? 390 : 720;
  const logicalH = portrait ? 700 : 480;
  const cssScale = Math.min(vpW / logicalW, vpH / logicalH);

  const panelBase: React.CSSProperties = {
    background: "rgba(5,15,40,0.92)",
    border: "2px solid #1e3a6e",
    borderRadius: 8,
    fontFamily: '"Courier New", Courier, monospace',
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
      {/* Background */}
      <img
        src={game1BgSrc}
        alt=""
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
          animation: calls.length > 0 ? "screenShake 0.08s infinite" : "none",
        }}
      >
        {/* Inner game area */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: logicalW,
            height: logicalH,
            transform: `translate(-50%, -50%) scale(${cssScale})`,
            transformOrigin: "center center",
          }}
        >
          <canvas
            ref={canvasRef}
            width={logicalW}
            height={logicalH}
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
                  top: 8,
                  left: 8,
                  display: "flex",
                  gap: 6,
                  zIndex: 40,
                }}
              >
                <div
                  style={{
                    ...panelBase,
                    padding: "4px 10px 5px",
                    minWidth: portrait ? 96 : 108,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#f0c040",
                      letterSpacing: 2,
                      fontWeight: 700,
                      marginBottom: 1,
                    }}
                  >
                    SCORE
                  </div>
                  <div
                    style={{
                      fontSize: portrait ? 20 : 22,
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
                    padding: "4px 10px 5px",
                    minWidth: portrait ? 78 : 88,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#aad4ff",
                      letterSpacing: 2,
                      fontWeight: 700,
                      marginBottom: 1,
                    }}
                  >
                    TIME
                  </div>
                  <div
                    style={{
                      fontSize: portrait ? 20 : 22,
                      fontWeight: 700,
                      color: timeLeftDisplay < 10000 ? "#f87171" : "#fff",
                      letterSpacing: 1,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      animation:
                        timeLeftDisplay < 10000
                          ? "blink 0.8s infinite"
                          : "none",
                    }}
                  >
                    <span style={{ fontSize: 13 }}>⏱</span>
                    {Math.ceil(timeLeftDisplay / 1000)}
                  </div>
                </div>
              </div>

              {/* ── TOP CENTER: 今日特餐 ───────────── */}
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 40,
                  ...panelBase,
                  padding: "4px 12px 5px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: "#f0c040",
                    letterSpacing: 2,
                    fontWeight: 700,
                    marginBottom: 3,
                  }}
                >
                  NEXT
                </div>
                <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  {dailySpecialDisplay.map((sf) => {
                    const img = IMG_CACHE.get(sf);
                    return img ? (
                      <div
                        key={sf}
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 6,
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
                            width: 28,
                            height: 28,
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
                  top: 8,
                  right: 8,
                  display: "flex",
                  gap: 6,
                  alignItems: "flex-start",
                  zIndex: 40,
                }}
              >
                <div
                  style={{
                    ...panelBase,
                    padding: "4px 10px 6px",
                    width: portrait ? 148 : 168,
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#f0c040",
                      letterSpacing: 2,
                      fontWeight: 700,
                      marginBottom: 2,
                    }}
                  >
                    MISSION
                  </div>
                  <div
                    style={{
                      fontSize: portrait ? 9 : 10,
                      color: "#e2e8f0",
                      marginBottom: 5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    下班前達到 {MISSION_TARGET} 分！
                  </div>
                  <div
                    style={{
                      height: 8,
                      background: "rgba(255,255,255,0.1)",
                      borderRadius: 4,
                      overflow: "hidden",
                      marginBottom: 3,
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
                        borderRadius: 4,
                        transition: "width 0.4s ease",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 9,
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
                    onBack();
                  }}
                  style={{
                    width: 42,
                    height: 42,
                    background: "linear-gradient(135deg,#1e3a8a,#2563eb)",
                    border: "2px solid #60a5fa",
                    borderRadius: 8,
                    color: "#fff",
                    fontSize: 16,
                    cursor: "pointer",
                    touchAction: "manipulation",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px rgba(37,99,235,0.5)",
                    flexShrink: 0,
                  }}
                >
                  ▐▐
                </button>
              </div>

              {/* ── BOTTOM ROW: COMBO | D-pad | STATUS ─ */}
              <div
                style={{
                  position: "absolute",
                  bottom: 8,
                  left: 8,
                  right: 8,
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
                    padding: "6px 10px 8px",
                    width: portrait ? 92 : 108,
                    pointerEvents: "auto",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#f0c040",
                      letterSpacing: 2,
                      fontWeight: 700,
                      marginBottom: 2,
                    }}
                  >
                    COMBO
                  </div>
                  <div
                    style={{
                      color: comboDisplay === 0 ? "#6b7280" : comboColor,
                      fontSize: portrait ? 24 : 28,
                      fontWeight: 700,
                      letterSpacing: 1,
                      lineHeight: 1,
                      marginBottom: 4,
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
                      height: 5,
                      borderRadius: 3,
                      background: "rgba(255,255,255,0.1)",
                      overflow: "hidden",
                      marginBottom: 3,
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.min((comboDisplay / 30) * 100, 100)}%`,
                        background:
                          "linear-gradient(90deg,#22c55e,#3b82f6,#a855f7,#f59e0b)",
                        borderRadius: 3,
                        transition: "width 0.2s ease",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 9, color: "#6b7280" }}>
                    最高 {maxComboDisplay}
                  </div>
                </div>

                {/* D-pad */}
                <div
                  style={{
                    display: "flex",
                    gap: portrait ? 10 : 12,
                    pointerEvents: "auto",
                  }}
                >
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
                        width: portrait ? 76 : 72,
                        height: portrait ? 76 : 72,
                        background: "linear-gradient(135deg,#1e3a8a,#2563eb)",
                        border: "3px solid rgba(147,197,253,0.7)",
                        borderRadius: 14,
                        color: "#fff",
                        fontSize: 26,
                        fontWeight: 700,
                        cursor: "pointer",
                        touchAction: "none",
                        userSelect: "none",
                        boxShadow:
                          "0 4px 14px rgba(37,99,235,0.5), inset 0 1px 0 rgba(255,255,255,0.15)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {dir === -1 ? "←" : "→"}
                    </button>
                  ))}
                </div>

                {/* STATUS */}
                <div
                  style={{
                    ...panelBase,
                    padding: "6px 10px 8px",
                    width: portrait ? 128 : 150,
                    pointerEvents: "auto",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#f0c040",
                      letterSpacing: 2,
                      fontWeight: 700,
                      marginBottom: 5,
                    }}
                  >
                    STATUS
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 7,
                    }}
                  >
                    <span style={{ fontSize: 18 }}>
                      {fatDisplay ? "🤢" : "😊"}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 9,
                          color: "#cbd5e1",
                          marginBottom: 2,
                        }}
                      >
                        體重
                      </div>
                      <div
                        style={{
                          height: 6,
                          background: "rgba(255,255,255,0.1)",
                          borderRadius: 3,
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
                            borderRadius: 3,
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
                        borderRadius: 5,
                        padding: "2px 6px",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <span style={{ fontSize: 10 }}>⏱</span>
                      <span
                        style={{
                          fontSize: 12,
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
                          fontSize: 9,
                          color: "#f87171",
                          fontWeight: 700,
                          animation: "blink 0.6s infinite",
                        }}
                      >
                        反轉中
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
                  onAnswer={handleAnswer}
                  onDecline={handleDecline}
                />
              ))}
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
                top: 10,
                left: 10,
                zIndex: 60,
                padding: "6px 12px",
                background: "rgba(0,0,0,0.5)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 8,
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "sans-serif",
                touchAction: "manipulation",
              }}
            >
              ← 返回
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
