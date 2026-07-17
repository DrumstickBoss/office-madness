import { useRef, useEffect, useState, useCallback } from "react";
import { addRecord, getBestForLevel } from "./leaderboard";
import { startLevel3Bgm, stopLevel3Bgm } from "./game3bgm";

// ─── Canvas dimensions ────────────────────────────────────────────────────────
const isPortraitViewport = () =>
  typeof window !== "undefined" && window.innerWidth < window.innerHeight;

let CW = typeof window !== "undefined" ? window.innerWidth : 390;
let CH = typeof window !== "undefined" ? window.innerHeight : 700;
const _p0 = typeof window !== "undefined" && isPortraitViewport();
let LW = _p0 ? 390 : 720;
let GS = typeof window !== "undefined" ? CW / LW : 1;
let LH = typeof window !== "undefined" ? Math.round(CH / GS) : _p0 ? 700 : 480;

// ─── Game tuning ──────────────────────────────────────────────────────────────
const RUN_MS = 45_000;
const JUMP_VY = -300;
const GRAVITY = 950;
const FALLEN_DURATION = 2000;
const SCROLL_SPEED = 270; // px/s
const OBS_BASE_SPD = 280; // px/s
const OBS_MIN_GAP_MS = 2200;
const OBS_MAX_GAP_MS = 3600;
const OBS_MIN_PIX_GAP = 280; // minimum pixel distance between obstacles at spawn
const SNAP_MIN_MS = 5000;
const SNAP_MAX_MS = 9000;
const SNAP_CLICK_MS = 3000;
const WHITE_FLASH_MS = 3000;
const FLAG_BLOCK_MS = 2000;
const FLAG_FADE_MS = 600;
const SCORE_PER_SEC = 8;
const SCORE_OBS_DODGE = 10;
const SPEED_BOOST_MS = 4000; // powerup duration
const SPEED_MULT = 1.65; // scroll / obstacle speed multiplier when boosted

// The scene art (stage3-bg.mp4, 1280x720) is laid out full-width and centred
// vertically, so it occupies a 16:9 band rather than the whole window. The
// running track sits a little under a third of the way up from that band's
// bottom edge. Player, obstacles and powerups all derive from this one line,
// so they stay locked to the track together at any window size.
// Lower FLOOR_FRAC moves everything down the track; raise it to move up.
const BG_RATIO = 9 / 16;
const FLOOR_FRAC = 0.28;
const FLOOR_Y = () => LH / 2 + LW * BG_RATIO * (0.5 - FLOOR_FRAC);

const PLAYER_X_FRAC = 0.2;
const PLAYER_W = 40;
const PLAYER_H = 66;
// The fallen sprite reads smaller than the running one at the same height, so
// it gets a slight bump to stay visually consistent.
const FALLEN_SCALE = 1.15;

// ─── Types ────────────────────────────────────────────────────────────────────
type Status = "idle" | "playing" | "gameover";
type PlayerState = "running" | "jumping" | "fallen";
type ObsType = "puddle" | "railing" | "shoe" | "drink";
type SnapType = "photographer" | "cheerleader";

interface Obstacle {
  id: number;
  type: ObsType;
  x: number;
  passed: boolean;
  hint?: string; // shown above the obstacle on first appearance
  shoeVariant?: number; // 1-7, which shoe sprite to draw
  struck?: boolean; // hit by player — stays on screen, no longer collides
}

interface SnapEvent {
  id: number;
  type: SnapType;
  side: "left" | "right";
  spawnAt: number;
  dismissed: boolean;
  cheerVariant?: number; // 1 or 2, which cheer sprite for cheerleaders
}

interface Popup {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  bornAt: number;
  bubble?: boolean; // render as pixel speech bubble (same style as "點我！")
  expireAt?: number; // if set, stays pinned (no float/fade) until this time
  bubbleFill?: string; // bubble background colour (defaults to boost scheme)
  bubbleBd?: string; // bubble border/text colour (defaults to boost scheme)
  followPlayer?: boolean; // reposition above the player's head each frame
}

interface GameState {
  status: Status;
  score: number;
  hiScore: number;
  elapsed: number;
  lastFrameTs: number;
  // Player
  playerY: number;
  playerVY: number;
  playerState: PlayerState;
  fallenUntil: number;
  legFrame: number;
  legTimer: number;
  // World
  scrollX: number;
  // Obstacles
  obstacles: Obstacle[];
  nextObsAt: number;
  // Snap events
  snapEvents: SnapEvent[];
  nextSnapAt: number;
  whiteFlash: boolean;
  whiteFlashUntil: number;
  flagBlock: boolean;
  flagBlockUntil: number;
  flagFading: boolean;
  flagFadeUntil: number;
  // Powerup
  speedBoostUntil: number;
  jumpImgUntil: number;
  // First-obstacle tutorial flags
  firstObstacleSeen: boolean;
  // Spawn separation
  lastSpawnWasPowerup: boolean;
  // Misc
  idCounter: number;
  popups: Popup[];
  evtDirty: boolean;
  scoreSaved: boolean;
}

// ─── Web Audio SFX ────────────────────────────────────────────────────────────
let sfxCtx: AudioContext | null = null;

const getSfxCtx = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  try {
    if (!sfxCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      sfxCtx = new Ctor();
    }
    if (sfxCtx.state === "suspended") sfxCtx.resume().catch(() => {});
    return sfxCtx;
  } catch {
    return null;
  }
};

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  delay = 0,
) {
  const ctx = getSfxCtx();
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

const sfxJump = () => {
  tone(440, 0.07, "square", 0.07);
  tone(660, 0.09, "square", 0.06, 0.05);
};
const sfxFall = () => {
  tone(440, 0.06, "sawtooth", 0.1);
  tone(220, 0.24, "sawtooth", 0.11, 0.05);
  if (typeof navigator !== "undefined" && navigator.vibrate)
    try {
      navigator.vibrate([60, 40, 120]);
    } catch {}
};
const sfxDodge = () => tone(880, 0.05, "triangle", 0.07);
const sfxSnap = () => {
  tone(2200, 0.04, "square", 0.14);
  tone(1100, 0.07, "sawtooth", 0.09, 0.03);
};
const sfxBoost = () => {
  [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(f, 0.1, "square", 0.09, i * 0.07),
  );
};
const sfxSplash = () => {
  tone(600, 0.04, "sawtooth", 0.07);
  tone(350, 0.1, "sawtooth", 0.06, 0.04);
};
const sfxSmash = () => {
  tone(180, 0.04, "sawtooth", 0.13);
  tone(110, 0.12, "sawtooth", 0.11, 0.04);
};

// ─── BGM — 運動會進行曲 (sports-day march), synthesized in game3bgm.ts ──────────
// (See startLevel3Bgm / stopLevel3Bgm; styled after the Lobby's chiptune bgm.ts.)

// ─── Helpers ──────────────────────────────────────────────────────────────────
const rng3 = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function addPopup(
  gs: GameState,
  x: number,
  y: number,
  text: string,
  color: string,
  now: number,
  bubble = false,
  expireAt?: number,
  bubbleFill?: string,
  bubbleBd?: string,
  followPlayer = false,
) {
  gs.popups.push({
    id: gs.idCounter++,
    x,
    y,
    text,
    color,
    bornAt: now,
    bubble,
    expireAt,
    bubbleFill,
    bubbleBd,
    followPlayer,
  });
  if (gs.popups.length > 18) gs.popups.splice(0, gs.popups.length - 18);
}

// ─── Initial state ────────────────────────────────────────────────────────────
function makeState(): GameState {
  return {
    status: "idle",
    score: 0,
    hiScore: getBestForLevel(3) ?? 0,
    elapsed: 0,
    lastFrameTs: 0,
    playerY: FLOOR_Y(),
    playerVY: 0,
    playerState: "running",
    fallenUntil: 0,
    legFrame: 0,
    legTimer: 0,
    scrollX: 0,
    obstacles: [],
    nextObsAt: 2000,
    snapEvents: [],
    nextSnapAt: rng3(SNAP_MIN_MS, SNAP_MAX_MS),
    whiteFlash: false,
    whiteFlashUntil: 0,
    flagBlock: false,
    flagBlockUntil: 0,
    flagFading: false,
    flagFadeUntil: 0,
    speedBoostUntil: 0,
    jumpImgUntil: 0,
    firstObstacleSeen: false,
    lastSpawnWasPowerup: false,
    idCounter: 0,
    popups: [],
    evtDirty: false,
    scoreSaved: false,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────
const EMOJI = (px: number) =>
  `${px}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;

const _frameImg = (() => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage3/frame.png`;
  return img;
})();

const _puddleImg = (() => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage3/puddle.gif`;
  return img;
})();

const _drinkImg = (() => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage3/drink.png`;
  return img;
})();

const _shoeImgs: HTMLImageElement[] = Array.from({ length: 7 }, (_, i) => {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}sprites/stage3/shoe-${i + 1}.gif`;
  return img;
});

// Colour scheme for the "加速四秒(無敵狀態)" boost bubble
const BOOST_BUBBLE_FILL = "#dbeafe";
const BOOST_BUBBLE_BD = "#1e3a8a";

// Pixel-art speech bubble on the game canvas — matches the photographer's
// "點我！" bubble (drawCamBubble). Tail tip lands at (cx, tipY).
function drawPixelBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  tipY: number,
  text: string,
  fill = "#fef9c3",
  border = "#78350f",
) {
  const FILL = fill;
  const BD = border;
  const FONT = `bold 13px 'Cubic11','Noto Sans TC',sans-serif`;
  const padX = 10;
  const bh = 24;
  const tailH = 6;
  ctx.save();
  ctx.font = FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const bw = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const bx = Math.round(cx - bw / 2);
  const by = Math.round(tipY - tailH - bh);
  ctx.translate(bx, by);
  ctx.fillStyle = FILL;
  ctx.fillRect(2, 2, bw - 4, bh - 4);
  ctx.fillStyle = BD;
  ctx.fillRect(2, 0, bw - 4, 2);
  ctx.fillRect(2, bh - 2, bw - 4, 2);
  ctx.fillRect(0, 2, 2, bh - 4);
  ctx.fillRect(bw - 2, 2, 2, bh - 4);
  ctx.fillRect(2, 2, 2, 2);
  ctx.fillRect(bw - 4, 2, 2, 2);
  ctx.fillRect(2, bh - 4, 2, 2);
  ctx.fillRect(bw - 4, bh - 4, 2, 2);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillRect(4, 2, bw - 8, 1);
  ctx.fillRect(2, 4, 1, bh - 6);
  ctx.fillStyle = BD;
  ctx.fillText(text, bw / 2, bh / 2 + 1);
  // hollow stepped tail pointing down
  const tx = bw / 2;
  ctx.fillStyle = BD;
  ctx.fillRect(tx - 3, bh, 6, 2);
  ctx.fillRect(tx - 2, bh + 2, 4, 2);
  ctx.fillRect(tx - 1, bh + 4, 2, 2);
  ctx.fillStyle = FILL;
  ctx.fillRect(tx - 2, bh, 4, 2);
  ctx.fillRect(tx - 1, bh + 2, 2, 2);
  ctx.restore();
}

function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: Obstacle[]) {
  const floorY = FLOOR_Y();
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  for (const obs of obstacles) {
    ctx.shadowBlur = 0;

    if (obs.type === "puddle") {
      if (_puddleImg.complete && _puddleImg.naturalWidth > 0) {
        const pH = 32;
        const pW = Math.round(
          pH * (_puddleImg.naturalWidth / _puddleImg.naturalHeight),
        );
        ctx.drawImage(_puddleImg, obs.x - pW / 2, floorY - pH + 10, pW, pH);
      } else {
        ctx.fillStyle = "rgba(80,160,240,0.55)";
        ctx.beginPath();
        ctx.ellipse(obs.x, floorY - 3, 30, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (obs.type === "shoe") {
      const img = _shoeImgs[(obs.shoeVariant ?? 1) - 1];
      if (img && img.complete && img.naturalWidth > 0) {
        const sH = 46;
        const sW = Math.round(sH * (img.naturalWidth / img.naturalHeight));
        ctx.drawImage(img, obs.x - sW / 2, floorY - sH + 4, sW, sH);
      } else {
        ctx.font = EMOJI(40);
        ctx.fillText("👟", obs.x, floorY - 2);
      }
    } else if (obs.type === "drink") {
      if (_drinkImg.complete && _drinkImg.naturalWidth > 0) {
        const dH = 48;
        const dW = Math.round(
          dH * (_drinkImg.naturalWidth / _drinkImg.naturalHeight),
        );
        ctx.drawImage(_drinkImg, obs.x - dW / 2, floorY - dH + 2, dW, dH);
      } else {
        ctx.font = EMOJI(40);
        ctx.fillText("🥤", obs.x, floorY - 2);
      }
    } else {
      // Railing — frame.png image, jump over it
      if (_frameImg.complete && _frameImg.naturalWidth > 0) {
        const fH = 72;
        const fW = Math.round(
          fH * (_frameImg.naturalWidth / _frameImg.naturalHeight),
        );
        if (obs.struck) {
          // Knocked over — topple forward (to the right, the run direction)
          ctx.save();
          ctx.translate(obs.x, floorY + 12);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(_frameImg, -fW / 2, -fH, fW, fH);
          ctx.restore();
        } else {
          ctx.drawImage(_frameImg, obs.x - fW / 2, floorY - fH + 16, fW, fH);
        }
      }
    }
    ctx.shadowBlur = 0;

    // Tutorial hint label for the first puddle / first railing —
    // pixel speech bubble matching the photographer's "點我！" style.
    if (obs.hint) {
      const tipY = obs.type === "railing" ? floorY - PLAYER_H - 8 : floorY - 44;
      drawPixelBubble(ctx, obs.x, tipY, obs.hint);
    }
  }
  ctx.restore();
}

function drawPlayer(ctx: CanvasRenderingContext2D, gs: GameState) {
  const px = Math.round(LW * PLAYER_X_FRAC);
  const cx = px + PLAYER_W / 2;
  const { playerY } = gs;
  const floorY = FLOOR_Y();
  ctx.save();

  // Ground shadow (shrinks as player rises during jump). The player sprite
  // itself is a DOM <img>; the fallen state is shown by blinking that image.
  const dist = floorY - playerY;
  const sc = Math.max(0.25, 1 - dist / 160);
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(0,0,0,${0.12 * sc})`;
  ctx.beginPath();
  ctx.ellipse(cx, floorY + 3, 20 * sc, 5 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPopups(
  ctx: CanvasRenderingContext2D,
  popups: Popup[],
  now: number,
) {
  for (const p of popups) {
    const age = now - p.bornAt;
    const pinned = p.expireAt != null;
    if (pinned) {
      if (now >= (p.expireAt as number)) continue;
    } else if (age > 1200) continue;
    const alpha = pinned ? 1 : 1 - age / 1200;
    const y = pinned ? p.y : p.y - age * 0.055;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.bubble) {
      // Pixel speech-bubble shape; each popup can carry its own colour scheme
      drawPixelBubble(
        ctx,
        p.x,
        y,
        p.text,
        p.bubbleFill ?? BOOST_BUBBLE_FILL,
        p.bubbleBd ?? BOOST_BUBBLE_BD,
      );
      ctx.restore();
      continue;
    }
    ctx.font = `bold 20px "Cubic11","Noto Sans TC",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    ctx.strokeText(p.text, p.x, y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, y);
    ctx.restore();
  }
}

function renderFrame(canvas: HTMLCanvasElement, gs: GameState, now: number) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  ctx.save();
  ctx.scale(GS, GS);

  ctx.clearRect(0, 0, CW / GS, LH);
  drawObstacles(ctx, gs.obstacles);
  drawPlayer(ctx, gs);
  drawPopups(ctx, gs.popups, now);

  ctx.restore();
}

// ─── Collision detection ──────────────────────────────────────────────────────
function checkCollisions(gs: GameState, now: number) {
  if (gs.playerState === "fallen") return;
  const px = Math.round(LW * PLAYER_X_FRAC);
  const floorY = FLOOR_Y();
  const jumping = gs.playerState === "jumping";
  const pLeft = px + 6;
  const pRight = px + PLAYER_W - 6;

  for (let i = gs.obstacles.length - 1; i >= 0; i--) {
    const obs = gs.obstacles[i];

    if (obs.x < -80) {
      gs.obstacles.splice(i, 1);
      continue;
    }

    const obsHW = obs.type === "railing" ? 32 : 26;
    const obsLeft = obs.x - obsHW;
    const obsRight = obs.x + obsHW;

    // Dodge score for obstacles that pass harmlessly
    if (!obs.passed && obsRight < pLeft) {
      obs.passed = true;
      if (obs.type !== "shoe" && obs.type !== "drink") {
        gs.score += SCORE_OBS_DODGE;
        sfxDodge();
      }
    }

    // Already struck obstacles remain on screen but no longer collide
    if (obs.struck) continue;

    // X overlap
    if (pRight < obsLeft || pLeft > obsRight) continue;

    if (obs.type === "shoe" || obs.type === "drink") {
      // Powerup is ~40px tall on the ground; skip if player jumped over it
      if (jumping && gs.playerY < floorY - 40) continue;
      gs.speedBoostUntil = now + SPEED_BOOST_MS;
      sfxBoost();
      addPopup(
        gs,
        obs.x,
        floorY - 80,
        "加速四秒(無敵狀態)",
        "#ffd700",
        now,
        true,
        gs.speedBoostUntil,
        undefined,
        undefined,
        true,
      );
      gs.obstacles.splice(i, 1);
      gs.evtDirty = true;
      continue;
    }

    // Both puddle and railing: must jump over
    const hit = !jumping || gs.playerY > floorY - 12;

    if (hit) {
      if (now < gs.speedBoostUntil) {
        // Invincible: smash/slide through, award bonus. Obstacle stays on
        // screen (railing knocked over) but no longer collides.
        gs.score += SCORE_OBS_DODGE;
        obs.struck = true;
        obs.passed = true;
        if (obs.type === "puddle") {
          sfxSplash();
        } else {
          sfxSmash();
        }
        gs.evtDirty = true;
        continue;
      }
      gs.playerState = "fallen";
      gs.fallenUntil = now + FALLEN_DURATION;
      gs.playerVY = 0;
      gs.playerY = floorY;
      sfxFall();
      obs.struck = true;
      obs.passed = true;
      addPopup(
        gs,
        px + PLAYER_W / 2,
        floorY - 90,
        "跌倒！定住2秒",
        "#ff4444",
        now,
        true,
        gs.fallenUntil,
        "#fee2e2",
        "#991b1b",
      );
      gs.evtDirty = true;
      return;
    }
  }
}

// ─── Game update ──────────────────────────────────────────────────────────────
function update(gs: GameState, now: number, dt: number) {
  const dtMs = dt * 1000;
  gs.elapsed += dtMs;

  if (gs.elapsed >= RUN_MS) {
    endGame(gs);
    return;
  }

  const floorY = FLOOR_Y();
  const boosted = now < gs.speedBoostUntil;
  const spd = boosted ? SPEED_MULT : 1.0;

  // Player state machine
  if (gs.playerState === "fallen") {
    // World pauses while fallen; timer (elapsed) still advances above
    if (now >= gs.fallenUntil) {
      gs.playerState = "running";
      gs.playerY = floorY;
      gs.playerVY = 0;
      gs.evtDirty = true;
    }
  } else {
    gs.score += SCORE_PER_SEC * spd * dt;
    gs.scrollX += SCROLL_SPEED * spd * dt;

    if (gs.playerState === "jumping") {
      gs.playerVY += GRAVITY * dt;
      gs.playerY += gs.playerVY * dt;
      if (gs.playerY >= floorY) {
        gs.playerY = floorY;
        gs.playerVY = 0;
        gs.playerState = "running";
      }
    }

    gs.legTimer -= dtMs;
    if (gs.legTimer <= 0) {
      gs.legFrame = (gs.legFrame + 1) % 8;
      gs.legTimer = boosted ? 55 : 90;
    }

    // Spawn obstacles — also enforce a minimum pixel gap so they never bunch up
    if (gs.elapsed >= gs.nextObsAt) {
      const rightmost = gs.obstacles.reduce(
        (m, o) => Math.max(m, o.x),
        -Infinity,
      );
      const pixOk =
        gs.obstacles.length === 0 || LW + 65 - rightmost >= OBS_MIN_PIX_GAP;
      if (pixOk) {
        spawnObstacle(gs);
        const timeMult = 1 + (gs.elapsed / RUN_MS) * 0.5;
        gs.nextObsAt =
          gs.elapsed + rng3(OBS_MIN_GAP_MS, OBS_MAX_GAP_MS) / timeMult;
      }
    }

    // Move obstacles leftward
    const obsSpeed = OBS_BASE_SPD * (1 + (gs.elapsed / RUN_MS) * 0.5) * spd;
    for (const obs of gs.obstacles) obs.x -= obsSpeed * dt;

    checkCollisions(gs, now);
  }

  // Snap events — never spawn a new one while another is still on screen or
  // while its screen-blocking effect (flash / flag) is still playing out, so
  // the photographer and cheerleader never overlap or chain back-to-back.
  if (
    gs.elapsed >= gs.nextSnapAt &&
    gs.snapEvents.length === 0 &&
    !gs.whiteFlash &&
    !gs.flagBlock &&
    !gs.flagFading
  ) {
    const snapType: SnapType =
      Math.random() < 0.5 ? "photographer" : "cheerleader";
    gs.snapEvents.push({
      id: gs.idCounter++,
      type: snapType,
      side: Math.random() < 0.5 ? "left" : "right",
      spawnAt: now,
      dismissed: false,
      cheerVariant:
        snapType === "cheerleader" ? (Math.random() < 0.5 ? 1 : 2) : undefined,
    });
    gs.evtDirty = true;
  }

  const prevLen = gs.snapEvents.length;
  gs.snapEvents = gs.snapEvents.filter((e) => {
    if (e.dismissed) {
      // Clicked away in time — no effect; wait a full gap before the next one.
      gs.nextSnapAt = gs.elapsed + rng3(SNAP_MIN_MS, SNAP_MAX_MS);
      return false;
    }
    if (now - e.spawnAt > SNAP_CLICK_MS) {
      let effectMs: number;
      if (e.type === "photographer") {
        gs.whiteFlash = true;
        gs.whiteFlashUntil = now + WHITE_FLASH_MS;
        effectMs = WHITE_FLASH_MS;
        sfxSnap();
      } else {
        gs.flagBlock = true;
        gs.flagBlockUntil = now + FLAG_BLOCK_MS;
        effectMs = FLAG_BLOCK_MS + FLAG_FADE_MS;
      }
      // Only count the gap to the next distraction once this one's effect
      // has fully cleared, so distractions never appear consecutively.
      gs.nextSnapAt = gs.elapsed + effectMs + rng3(SNAP_MIN_MS, SNAP_MAX_MS);
      gs.evtDirty = true;
      return false;
    }
    return true;
  });
  if (gs.snapEvents.length !== prevLen) gs.evtDirty = true;

  if (gs.whiteFlash && now >= gs.whiteFlashUntil) {
    gs.whiteFlash = false;
    gs.evtDirty = true;
  }
  if (gs.flagBlock && now >= gs.flagBlockUntil) {
    gs.flagBlock = false;
    gs.flagFading = true;
    gs.flagFadeUntil = now + FLAG_FADE_MS;
    gs.evtDirty = true;
  }
  if (gs.flagFading && now >= gs.flagFadeUntil) {
    gs.flagFading = false;
    gs.evtDirty = true;
  }

  // Keep player-following bubbles (e.g. the boost bubble) above the player's
  // head, so they rise and fall with the jump.
  const pcx = Math.round(LW * PLAYER_X_FRAC) + PLAYER_W / 2;
  for (const p of gs.popups) {
    if (p.followPlayer) {
      p.x = pcx;
      p.y = gs.playerY - PLAYER_H - 30;
    }
  }

  gs.popups = gs.popups.filter((p) =>
    p.expireAt != null ? now < p.expireAt : now - p.bornAt < 1200,
  );
}

function spawnObstacle(gs: GameState) {
  const roll = Math.random();
  // After a powerup always spawn an obstacle so they never appear back-to-back
  const type: ObsType = gs.lastSpawnWasPowerup
    ? roll < 0.5
      ? "puddle"
      : "railing"
    : roll < 0.4
      ? "puddle"
      : roll < 0.8
        ? "railing"
        : roll < 0.9
          ? "shoe"
          : "drink";
  gs.lastSpawnWasPowerup = type === "shoe" || type === "drink";
  let hint: string | undefined;
  if (!gs.firstObstacleSeen && (type === "puddle" || type === "railing")) {
    hint = "跳躍！";
    gs.firstObstacleSeen = true;
  }
  gs.obstacles.push({
    id: gs.idCounter++,
    type,
    x: LW + 65,
    passed: false,
    hint,
    shoeVariant:
      type === "shoe" ? 1 + Math.floor(Math.random() * 7) : undefined,
  });
}

function endGame(gs: GameState) {
  gs.status = "gameover";
  stopLevel3Bgm();
  if (!gs.scoreSaved) {
    gs.scoreSaved = true;
    const final = Math.round(gs.score);
    if (final > gs.hiScore) gs.hiScore = final;
    addRecord(3, final);
  }
  gs.evtDirty = true;
}

// ─── React component ──────────────────────────────────────────────────────────
interface LevelProps {
  onBack: () => void;
}

interface UiState {
  status: Status;
  score: number;
  hiScore: number;
  timeLeft: number;
  snapEvents: SnapEvent[];
  whiteFlash: boolean;
  flagBlock: boolean;
  flagFading: boolean;
  speedBoosted: boolean;
  speedBoostSecsLeft: number;
  upHeldMs: number;
}

export default function Level3({ onBack }: LevelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gsRef = useRef<GameState>(makeState());
  const rafRef = useRef<number>(0);
  const upHeldAtRef = useRef(0);
  const playerRunImgRef = useRef<HTMLImageElement>(null);
  const playerJumpImgRef = useRef<HTMLImageElement>(null);
  const playerFallenImgRef = useRef<HTMLImageElement>(null);
  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const exitConfirmRef = useRef(false);

  const [ui, setUi] = useState<UiState>({
    status: "idle",
    score: 0,
    hiScore: gsRef.current.hiScore,
    timeLeft: RUN_MS / 1000,
    snapEvents: [],
    whiteFlash: false,
    flagBlock: false,
    flagFading: false,
    speedBoosted: false,
    speedBoostSecsLeft: 0,
    upHeldMs: 0,
  });
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [vpW, setVpW] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 390,
  );
  const [vpH, setVpH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 700,
  );

  const uiScale = Math.min(1.6, Math.max(0.65, Math.min(vpW, vpH) / 480));
  const s = (n: number) => Math.round(n * uiScale);

  // On-screen height of the player sprite, mirroring the render loop's own
  // `(PLAYER_H + 60) * GS`. The photographer and cheerleader size off this so
  // they read as the same scale of person as the player, rather than following
  // the HUD's uiScale.
  const playerPx = Math.round(
    (PLAYER_H + 60) * (vpW / (vpW < vpH ? 390 : 720)),
  );
  // The photographer and cheerleader stand back from the player, so they read
  // a little smaller than him rather than matching him exactly.
  const camPx = Math.round(playerPx * 0.85);
  // The cheerleader art only fills ~83% of its square frame (the rest is
  // padding), so the same box height leaves her reading smaller than the
  // photographer — this bumps her back up to match.
  const cheerPx = Math.round(camPx * 1.45);

  const font = '"Cubic11","Courier New",Courier,monospace';
  const panelBase: React.CSSProperties = {
    background: "rgba(5,15,40,0.92)",
    border: "2px solid #1e3a6e",
    borderRadius: s(8),
    fontFamily: font,
    boxShadow:
      "0 4px 16px rgba(0,0,0,0.7), inset 0 1px 0 rgba(100,160,255,0.08)",
    color: "#fff",
  };

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    CW = window.innerWidth;
    CH = window.innerHeight;
    const portrait = CW < CH;
    LW = portrait ? 390 : 720;
    GS = CW / LW;
    LH = Math.round(CH / GS);
    canvas.width = CW;
    canvas.height = CH;
    setVpW(CW);
    setVpH(CH);
    const gs = gsRef.current;
    if (gs.playerState !== "jumping") gs.playerY = FLOOR_Y();
  }, []);

  const startGame = useCallback(() => {
    const gs = makeState();
    gs.hiScore = gsRef.current.hiScore;
    gsRef.current = gs;
    gsRef.current.lastFrameTs = performance.now();
    gsRef.current.status = "playing";
    resizeCanvas();
    stopLevel3Bgm();
    startLevel3Bgm();
    setUi({
      status: "playing",
      score: 0,
      hiScore: gs.hiScore,
      timeLeft: RUN_MS / 1000,
      snapEvents: [],
      whiteFlash: false,
      flagBlock: false,
      flagFading: false,
      speedBoosted: false,
      speedBoostSecsLeft: 0,
      upHeldMs: 0,
    });
  }, [resizeCanvas]);

  const dismissSnap = useCallback((id: number) => {
    const gs = gsRef.current;
    const evt = gs.snapEvents.find((e) => e.id === id);
    if (evt) {
      evt.dismissed = true;
      gs.evtDirty = true;
    }
  }, []);

  const drawCamBubble = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    const FILL = "#fef9c3",
      BD = "#78350f";
    const fontSize = 11;
    const FONT = `bold ${fontSize}px 'Cubic11', monospace`;
    const text = "點我！";
    const padX = 8,
      bh = 22;
    const tmp = document.createElement("canvas").getContext("2d")!;
    tmp.font = FONT;
    const bw = Math.ceil(tmp.measureText(text).width) + padX * 2;
    const tailH = 6;
    canvas.width = Math.round(bw * GS);
    canvas.height = Math.round((bh + tailH) * GS);
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(GS, GS);
    ctx.font = FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // drawPixelBox(0, 0, bw, bh)
    ctx.fillStyle = FILL;
    ctx.fillRect(2, 2, bw - 4, bh - 4);
    ctx.fillStyle = BD;
    ctx.fillRect(2, 0, bw - 4, 2);
    ctx.fillRect(2, bh - 2, bw - 4, 2);
    ctx.fillRect(0, 2, 2, bh - 4);
    ctx.fillRect(bw - 2, 2, 2, bh - 4);
    ctx.fillRect(2, 2, 2, 2);
    ctx.fillRect(bw - 4, 2, 2, 2);
    ctx.fillRect(2, bh - 4, 2, 2);
    ctx.fillRect(bw - 4, bh - 4, 2, 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillRect(4, 2, bw - 8, 1);
    ctx.fillRect(2, 4, 1, bh - 6);
    ctx.fillStyle = BD;
    ctx.fillText(text, bw / 2, bh / 2 + 1);
    // hollow stepped tail pointing down
    const tx = bw / 2;
    ctx.fillStyle = BD;
    ctx.fillRect(tx - 3, bh, 6, 2);
    ctx.fillRect(tx - 2, bh + 2, 4, 2);
    ctx.fillRect(tx - 1, bh + 4, 2, 2);
    ctx.fillStyle = FILL;
    ctx.fillRect(tx - 2, bh, 4, 2);
    ctx.fillRect(tx - 1, bh + 2, 2, 2);
  }, []);

  const doJump = useCallback(() => {
    const gs = gsRef.current;
    if (gs.status !== "playing") return;
    if (gs.playerState === "running") {
      gs.playerState = "jumping";
      gs.playerVY = JUMP_VY;
      gs.jumpImgUntil = performance.now() + 600;
      sfxJump();
    }
  }, []);

  // Keyboard
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "ArrowUp" || e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) {
          upHeldAtRef.current = performance.now();
          doJump();
        }
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "ArrowUp" || e.code === "Space") upHeldAtRef.current = 0;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [doJump]);

  // Game loop
  useEffect(() => {
    const loop = (ts: number) => {
      const gs = gsRef.current;
      if (gs.status === "playing" && !exitConfirmRef.current) {
        const dt = Math.min((ts - gs.lastFrameTs) / 1000, 0.05);
        gs.lastFrameTs = ts;
        update(gs, ts, dt);
        const canvas = canvasRef.current;
        if (canvas) renderFrame(canvas, gs, ts);
        if (Math.floor(ts / 200) !== Math.floor((ts - dt * 1000) / 200))
          gs.evtDirty = true;
      }
      // Pause background video while fallen, while the exit modal is open
      // (game paused), or once the game is over; resume when running again.
      const vid = bgVideoRef.current;
      if (vid) {
        const shouldPause =
          gs.playerState === "fallen" ||
          exitConfirmRef.current ||
          gs.status !== "playing";
        if (shouldPause) {
          if (!vid.paused) vid.pause();
        } else {
          if (vid.paused) vid.play().catch(() => {});
        }
      }

      // Update DOM player sprite (GIF animates only in DOM, not canvas drawImage)
      const runEl = playerRunImgRef.current;
      const jumpEl = playerJumpImgRef.current;
      const fallenEl = playerFallenImgRef.current;
      if (runEl && jumpEl && fallenEl) {
        const cx_s = (Math.round(LW * PLAYER_X_FRAC) + PLAYER_W / 2) * GS;
        // Jump is shown by lifting the run sprite along its arc (playerY),
        // not by swapping to a separate jump image.
        const bot_s = (LH - 6 - gs.playerY) * GS;
        const h_s = (PLAYER_H + 60) * GS;
        const fallen = gs.playerState === "fallen";
        const hidden = gs.status !== "playing";
        // While frozen after tripping, swap to the dedicated fallen sprite.
        runEl.style.display = hidden || fallen ? "none" : "block";
        jumpEl.style.display = "none";
        fallenEl.style.display = hidden || !fallen ? "none" : "block";
        runEl.style.opacity = "1";
        // White halo while invincible (speed boost active).
        const boosted = ts < gs.speedBoostUntil;
        const glow = boosted
          ? "drop-shadow(0 0 6px rgba(255,255,255,0.95)) drop-shadow(0 0 16px rgba(255,255,255,0.85))"
          : "none";
        for (const el of [runEl, jumpEl, fallenEl]) {
          el.style.height = `${h_s}px`;
          el.style.width = "auto";
          el.style.left = `${cx_s}px`;
          el.style.bottom = `${bot_s}px`;
          el.style.transform = "translateX(-50%)";
          el.style.filter = glow;
        }
        fallenEl.style.height = `${h_s * FALLEN_SCALE}px`;
      }

      if (upHeldAtRef.current > 0) gs.evtDirty = true;

      if (gs.evtDirty) {
        gs.evtDirty = false;
        const now = performance.now();
        setUi({
          status: gs.status,
          score: Math.round(gs.score),
          hiScore: gs.hiScore,
          timeLeft: Math.max(0, (RUN_MS - gs.elapsed) / 1000),
          snapEvents: [...gs.snapEvents],
          whiteFlash: gs.whiteFlash,
          flagBlock: gs.flagBlock,
          flagFading: gs.flagFading,
          speedBoosted: now < gs.speedBoostUntil,
          speedBoostSecsLeft: Math.max(
            0,
            Math.ceil((gs.speedBoostUntil - now) / 1000),
          ),
          upHeldMs: upHeldAtRef.current > 0 ? now - upHeldAtRef.current : 0,
        });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      stopLevel3Bgm();
    };
  }, []);

  // Resize
  useEffect(() => {
    const h = () => resizeCanvas();
    window.addEventListener("resize", h);
    window.addEventListener("orientationchange", h);
    resizeCanvas();
    return () => {
      window.removeEventListener("resize", h);
      window.removeEventListener("orientationchange", h);
    };
  }, [resizeCanvas]);

  const isPlaying = ui.status === "playing";
  const isGameOver = ui.status === "gameover";
  const isIdle = ui.status === "idle";
  const secLeft = Math.ceil(ui.timeLeft);

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
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>

      {/* Background video — pauses when player is fallen, resumes after */}
      <video
        ref={bgVideoRef}
        src={`${import.meta.env.BASE_URL}sprites/stage3/stage3-bg.mp4`}
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
          pointerEvents: "none",
          filter: "brightness(1.3) contrast(1.1)",
        }}
      />

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
          background: "transparent",
        }}
      />

      {/* Player sprite — DOM img so GIF animates; position updated each RAF frame via ref */}
      <img
        ref={playerRunImgRef}
        src={`${import.meta.env.BASE_URL}sprites/stage3/run.gif`}
        alt=""
        style={{
          position: "absolute",
          pointerEvents: "none",
          display: "none",
          zIndex: 5,
          imageRendering: "pixelated",
        }}
      />
      <img
        ref={playerJumpImgRef}
        src={`${import.meta.env.BASE_URL}sprites/stage3/jump.gif`}
        alt=""
        style={{
          position: "absolute",
          pointerEvents: "none",
          display: "none",
          zIndex: 5,
          imageRendering: "pixelated",
        }}
      />
      {/* Fallen sprite — shown while player is frozen after tripping */}
      <img
        ref={playerFallenImgRef}
        src={`${import.meta.env.BASE_URL}sprites/stage3/pudau.gif`}
        alt=""
        style={{
          position: "absolute",
          pointerEvents: "none",
          display: "none",
          zIndex: 5,
          imageRendering: "pixelated",
        }}
      />

      {/* White flash */}
      {isPlaying && ui.whiteFlash && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "white",
            opacity: 0.95,
            pointerEvents: "none",
            zIndex: 16,
          }}
        />
      )}

      {/* Flag block — cracker laid out with the exact geometry as the
          background video above. Both sources are 16:9, so the poppers land
          flush with the scene band: full width, no stretching, no cropping. */}
      {isPlaying && (ui.flagBlock || ui.flagFading) && (
        <img
          src={`${import.meta.env.BASE_URL}sprites/stage3/cracker.gif`}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            width: "100%",
            height: "auto",
            transform: "translateY(-50%)",
            display: "block",
            pointerEvents: "none",
            zIndex: 15,
            opacity: ui.flagFading ? 0 : 1,
            transition: `opacity ${FLAG_FADE_MS}ms ease-out`,
          }}
        />
      )}

      {/* Snap event overlays */}
      {isPlaying &&
        ui.snapEvents.map((evt) =>
          evt.type === "photographer" ? (
            <div
              key={evt.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                dismissSnap(evt.id);
              }}
              style={{
                position: "absolute",
                top: "45%",
                left: "50%",
                zIndex: 20,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: s(4),
                animation: `${evt.side === "left" ? "snapSlideFromLeft" : "snapSlideFromRight"} 0.6s ease-out forwards, snapSway 3s ease-in-out 0.6s infinite`,
              }}
            >
              {/* Canvas-rendered pixel bubble — identical to GameCanvas drawPixelBox */}
              <canvas ref={drawCamBubble} style={{ display: "block" }} />
              <img
                src={`${import.meta.env.BASE_URL}sprites/stage3/camera.gif`}
                alt=""
                style={{ height: camPx, width: "auto", objectFit: "contain" }}
              />
            </div>
          ) : (
            <div
              key={evt.id}
              onPointerDown={(e) => {
                e.stopPropagation();
                dismissSnap(evt.id);
              }}
              style={{
                position: "absolute",
                top: "45%",
                left: "50%",
                zIndex: 20,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: s(4),
                // She is taller than the photographer, and the column is
                // top-anchored, so lift the whole block by the difference:
                // this bottom-aligns the two characters while leaving the
                // bubble to sit naturally above her head, as his does.
                marginTop: camPx - cheerPx,
                animation: `${evt.side === "left" ? "snapSlideFromLeft" : "snapSlideFromRight"} 0.6s ease-out forwards, snapSway 2s ease-in-out 0.6s infinite`,
              }}
            >
              {/* Canvas-rendered pixel bubble — same as the photographer, but
                  nudged down: her art carries transparent padding above the
                  flags, so a bubble sitting flush against the frame's top edge
                  floats well clear of her head. Scales with her so it holds at
                  any window size. */}
              <canvas
                ref={drawCamBubble}
                style={{
                  display: "block",
                  transform: `translateY(${Math.round(cheerPx * 0.12)}px)`,
                }}
              />
              <img
                src={`${import.meta.env.BASE_URL}sprites/stage3/cheer-0${evt.cheerVariant ?? 1}.gif`}
                alt=""
                draggable={false}
                style={{ height: cheerPx, width: "auto", objectFit: "contain" }}
              />
            </div>
          ),
        )}

      {/* HUD — SCORE / TIME / BOOST top-left */}
      {isPlaying && (
        <div
          style={{
            position: "absolute",
            top: s(8),
            left: s(8),
            display: "flex",
            gap: s(6),
            zIndex: 40,
            pointerEvents: "none",
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
              {ui.score}
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
                letterSpacing: 1,
                color: secLeft <= 10 ? "#f87171" : "#fff",
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
          {ui.speedBoosted && (
            <div
              style={{
                ...panelBase,
                padding: `${s(4)}px ${s(10)}px ${s(5)}px`,
                border: "2px solid #ff8c00",
              }}
            >
              <div
                style={{
                  fontSize: s(9),
                  color: "#ffd700",
                  letterSpacing: s(2),
                  fontWeight: 700,
                  marginBottom: s(1),
                }}
              >
                BOOST
              </div>
              <div
                style={{
                  fontSize: s(20),
                  fontWeight: 700,
                  color: "#ffd700",
                  display: "flex",
                  alignItems: "center",
                  gap: s(3),
                }}
              >
                ⚡{ui.speedBoostSecsLeft}s
              </div>
            </div>
          )}
        </div>
      )}

      {/* Exit button — sprite image, top-right during play */}
      {isPlaying && (
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
          <div style={{ ...panelBase, borderRadius: s(8), minWidth: s(260) }}>
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

      {/* Back button — sprite image when not playing */}
      {!isPlaying && (
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
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            touchAction: "none",
            userSelect: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}sprites/backto.png`}
            alt="返回大廳"
            draggable={false}
            style={{ height: s(48), objectFit: "contain" }}
          />
        </button>
      )}

      {/* Jump button */}
      {isPlaying && (
        <button
          onPointerDown={(e) => {
            e.stopPropagation();
            doJump();
          }}
          style={{
            position: "absolute",
            bottom: s(18),
            left: "50%",
            zIndex: 30,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            touchAction: "manipulation",
            transform:
              ui.upHeldMs > 0
                ? "translateX(-50%) scale(0.92)"
                : "translateX(-50%) scale(1)",
            transition: "transform 0.06s",
          }}
        >
          <img
            src={`${import.meta.env.BASE_URL}sprites/stage3/jump-button.png`}
            alt="跳躍"
            draggable={false}
            style={{ width: s(72), height: s(72), objectFit: "contain" }}
          />
        </button>
      )}

      {/* Idle screen — matches GameCanvas style (tap to start) */}
      {isIdle && (
        <div
          onPointerDown={startGame}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.72)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            gap: s(16),
            textAlign: "center",
            fontFamily: font,
            color: "#fff",
            cursor: "pointer",
            touchAction: "manipulation",
          }}
        >
          <div style={{ fontSize: s(30), fontWeight: 800, color: "#f0c040" }}>
            網銀運動會
          </div>
          <div style={{ fontSize: s(15), color: "#cbd5e1" }}>
            45 秒障礙跑，閃過障礙衝越遠越高分！
          </div>

          {/* Rule rows — left-aligned within centred block */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: s(12),
              fontSize: s(14),
              lineHeight: 1.5,
              textAlign: "left",
            }}
          >
            <div style={{ color: "#e2e8f0" }}>↑ / 跳躍鈕　跳躍避開障礙</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: s(6),
                color: "#4ade80",
              }}
            >
              <img
                src={`${import.meta.env.BASE_URL}sprites/stage3/shoe-1.gif`}
                alt="鞋子"
                style={{ width: s(26), height: s(26), objectFit: "contain" }}
              />
              <img
                src={`${import.meta.env.BASE_URL}sprites/stage3/drink.png`}
                alt="飲料"
                style={{ width: s(26), height: s(26), objectFit: "contain" }}
              />
              <span style={{ marginLeft: s(2) }}>加速無敵 4 秒！</span>
            </div>
            <div style={{ color: "#f87171" }}>小心攝影師和啦啦隊！</div>
          </div>
          <div
            style={{
              fontSize: s(17),
              fontWeight: 700,
              color: "#3090cf",
              marginTop: s(24),
            }}
          >
            點擊畫面開始遊戲
          </div>
        </div>
      )}

      {/* Gameover screen — matches GameCanvas style (tap to restart) */}
      {isGameOver && (
        <div
          onPointerDown={startGame}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: s(14),
            fontFamily: font,
            color: "#fff",
            cursor: "pointer",
            touchAction: "manipulation",
          }}
        >
          <div style={{ fontSize: s(30), fontWeight: 800, color: "#f0c040" }}>
            ⏰ 時間到！
          </div>
          <div style={{ fontSize: s(18), fontWeight: 800, color: "#fff" }}>
            最終分數：{ui.score}
          </div>
          <div style={{ fontSize: s(15), fontWeight: 700, color: "#f0c040" }}>
            最高分：{ui.hiScore}
          </div>
          <div
            style={{
              fontSize: s(16),
              fontWeight: 800,
              color: "#4ade80",
              marginTop: s(8),
            }}
          >
            點擊畫面重新開始
          </div>
        </div>
      )}
    </div>
  );
}
