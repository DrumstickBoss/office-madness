import { useState, useEffect, useRef } from "react";
import homeBg from "./assets/home_bg.png";
import stage1 from "./assets/stage_1.png";
import stage2 from "./assets/stage_2.png";
import stage3 from "./assets/stage_3.png";
import stage4 from "./assets/stage_4.png";
import mascot from "./assets/mascot.png";
import startGif from "./assets/Start.gif";
import rankingListBg from "./assets/rankinglist_alpha.png";
import ranking1_1 from "./assets/ranking/ranking1-1.png";
import ranking1_2 from "./assets/ranking/ranking1-2.png";
import ranking2_1 from "./assets/ranking/ranking2-1.png";
import ranking2_2 from "./assets/ranking/ranking2-2.png";
import ranking3_1 from "./assets/ranking/ranking3-1.png";
import ranking3_2 from "./assets/ranking/ranking3-2.png";
import ranking4_1 from "./assets/ranking/ranking4-1.png";
import ranking4_2 from "./assets/ranking/ranking4-2.png";
import { LEVELS, LevelDef, getStars } from "./gameData";
import { loadHistory, getBestForLevel, PlayRecord } from "./leaderboard";
import { loadProfile, saveProfile, getLevelInfo } from "./player";
import { startLobbyBgm, stopLobbyBgm, loadBgmMuted, saveBgmMuted } from "./bgm";

const STAGE_IMAGES: Record<number, string> = {
  1: stage1,
  2: stage2,
  3: stage3,
  4: stage4,
};

// Leaderboard tab art — one badge image per game, "-1" unselected / "-2" selected.
const RANKING_TAB_IMAGES: Record<number, { off: string; on: string }> = {
  1: { off: ranking1_1, on: ranking1_2 },
  2: { off: ranking2_1, on: ranking2_2 },
  3: { off: ranking3_1, on: ranking3_2 },
  4: { off: ranking4_1, on: ranking4_2 },
};

// mascot.png is a 1024x1024 full-body render — this crop box (in source px)
// isolates just the head/face for the leaderboard's crown badge portrait.
const MASCOT_HEAD_CROP = { x: 220, y: 60, size: 580, natural: 1024 };

// Renders a crop of just the mascot's head at any target size, by scaling the
// full image up and shifting it so the head crop lands in view. `radius`
// defaults to a circle but accepts any border-radius (e.g. for the rounded-
// square portrait frames used in the player card / start button).
function MascotHead({
  size,
  radius = "50%",
}: {
  size: number;
  radius?: number | string;
}) {
  const scale = size / MASCOT_HEAD_CROP.size;
  const imgSize = MASCOT_HEAD_CROP.natural * scale;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: "hidden",
        position: "relative",
        flexShrink: 0,
      }}
    >
      <img
        src={mascot}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          width: imgSize,
          height: imgSize,
          left: -MASCOT_HEAD_CROP.x * scale,
          top: -MASCOT_HEAD_CROP.y * scale,
        }}
      />
    </div>
  );
}

const formatTs = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface LobbyProps {
  onPlay: (levelId: number) => void;
}

export default function Lobby({ onPlay }: LobbyProps) {
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  const [history, setHistory] = useState<PlayRecord[]>(() => loadHistory());
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [boardTab, setBoardTab] = useState(LEVELS[0].id);
  const [profile, setProfile] = useState(() => loadProfile());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [, forceUpdate] = useState(0);
  const [bgmMuted, setBgmMuted] = useState(() => loadBgmMuted());
  const bgmMutedRef = useRef(bgmMuted);
  useEffect(() => {
    bgmMutedRef.current = bgmMuted;
  }, [bgmMuted]);

  // Re-read play history on mount (might have changed after a game)
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  // Looping chiptune BGM — only while the lobby is on screen. Browsers block audio
  // until a user gesture, so try immediately and again on the first tap/click.
  useEffect(() => {
    const tryStart = () => {
      if (!bgmMutedRef.current) startLobbyBgm();
    };
    tryStart();
    window.addEventListener("pointerdown", tryStart, { once: true });
    return () => {
      window.removeEventListener("pointerdown", tryStart);
      stopLobbyBgm();
    };
  }, []);

  const toggleBgmMuted = () => {
    const next = !bgmMuted;
    setBgmMuted(next);
    saveBgmMuted(next);
    if (next) stopLobbyBgm();
    else startLobbyBgm();
  };

  const levelInfo = getLevelInfo(history);

  const commitName = () => {
    const trimmed = nameDraft.trim().slice(0, 10) || profile.name;
    const updated = { ...profile, name: trimmed };
    setProfile(updated);
    saveProfile(updated);
    setEditingName(false);
  };

  // Recalculate layout on resize
  useEffect(() => {
    const onResize = () => forceUpdate((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const vw = typeof window !== "undefined" ? window.innerWidth : 720;
  const vh = typeof window !== "undefined" ? window.innerHeight : 480;
  // UI chrome (top/bottom bars, leaderboard modal) is anchored directly to the
  // real viewport's own edges/box below, so by construction it can never
  // exceed the screen — its internal sizing just uses this clamped scale
  // factor to stay reasonably sized without needing any overflow math.
  const scale = Math.min(1.6, Math.max(0.7, Math.min(vw, vh) / 480));

  // home_bg.png is 1672x941, width-driven: always fills 100% of the viewport
  // width (matches Level 1's background), with height following from the
  // aspect ratio — cropped top/bottom by the container's overflow:hidden if
  // it overflows, letterboxed in black if it doesn't fill the viewport. Only
  // the background + level circles use this scale (so the circles stay glued
  // to the art); the UI chrome above uses its own viewport-anchored scale
  // instead so it's never affected by the background being cropped.
  const IMG_ASPECT = 941 / 1672;
  const imgW = vw;
  const imgH = imgW * IMG_ASPECT;
  const imgLeft = 0;
  const imgTop = (vh - imgH) / 2;

  // Node positions as fractions (0..1) of the background image, sampled directly
  // from home_bg.png's four circles so they stay pinned to the art at any size.
  const levelNodes: Array<{ level: LevelDef; fx: number; fy: number }> = [
    { level: LEVELS[0], fx: 0.29, fy: 0.68 }, // GREEN  bottom-left
    { level: LEVELS[1], fx: 0.285, fy: 0.29 }, // YELLOW upper-left
    { level: LEVELS[2], fx: 0.67, fy: 0.3 }, // PURPLE upper-right
    { level: LEVELS[3], fx: 0.68, fy: 0.67 }, // BLUE   bottom-right
  ];

  const btnW = Math.round(Math.min(210, imgW * 0.16));

  // rankinglist_alpha.png is 1308x1203 — the leaderboard panel is sized to
  // that exact aspect ratio (no stretching), capped by BOTH a max width and a
  // max height (in real viewport px) so it can never exceed the screen.
  // Whichever cap is more restrictive wins.
  const RANK_ASPECT = 1308 / 1203;
  const rankModalW = Math.min(vw * 0.7, vh * 0.82 * RANK_ASPECT);
  const rankAvatarSize = Math.round(rankModalW * 0.14);

  const canStart =
    selectedLevel != null &&
    (LEVELS.find((l) => l.id === selectedLevel)?.unlocked ?? false);

  return (
    <div
      onPointerDown={() => setSelectedLevel(null)}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        fontFamily: "'Cubic11', sans-serif",
        background: "#000",
      }}
    >
      {/* Background image — width always fills the viewport (matches Level 1);
          height follows the aspect ratio and is cropped/letterboxed as needed.
          The four circles line up with fx/fy fractions below at any size. */}
      <img
        src={homeBg}
        style={{
          position: "absolute",
          left: imgLeft,
          top: imgTop,
          width: imgW,
          height: imgH,
          display: "block",
        }}
        alt=""
      />

      {/* Decorative start gif — centered over the plaza in the middle of the board */}
      <img
        src={startGif}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: imgLeft + 0.5 * imgW,
          top: imgTop + 0.67 * imgH,
          transform: "translate(-50%,-50%)",
          width: Math.round(180 * scale),
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      <style>{`
        @keyframes levelGlowPulse {
          0%, 100% { opacity: 1;   transform: scale(1);    }
          50%      { opacity: 0.75; transform: scale(1.14); }
        }
        @keyframes startBtnPulse {
          0%, 100% { box-shadow: 0 4px 14px rgba(240,160,32,0.45), 0 0 0 0 rgba(255,214,0,0.55); }
          50%      { box-shadow: 0 4px 22px rgba(240,160,32,0.75), 0 0 0 9px rgba(255,214,0,0); }
        }
        .start-btn { transition: transform 120ms ease; }
        .start-btn:active { transform: scale(0.93); }
      `}</style>

      {/* Level buttons — positioned over the circles in the background art */}
      {levelNodes.map(({ level, fx, fy }) => {
        const isSelected = selectedLevel === level.id;
        const best = level.unlocked ? getBestForLevel(level.id, history) : 0;
        return (
          <div
            key={level.id}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (level.unlocked) setSelectedLevel(level.id);
            }}
            style={{
              position: "absolute",
              zIndex: 2,
              left: imgLeft + fx * imgW,
              top: imgTop + fy * imgH,
              transform: `translate(-50%,-50%) scale(${isSelected ? 1.6 : 1.5})`,
              width: btnW,
              cursor: level.unlocked ? "pointer" : "default",
              touchAction: "manipulation",
              userSelect: "none",
              filter: level.unlocked ? "none" : "grayscale(1) brightness(0.65)",
              transition: "transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            {/* Glow halo — a soft pulsing disc behind the stage art, in a bright
                gold/yellow (matching the game's UI accent) so the selection reads
                clearly against any of the four background circles. */}
            {isSelected && (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: "60%",
                  height: "60%",
                  transform: "translate(-50%,-50%)",
                  borderRadius: "50%",
                  background:
                    "radial-gradient(circle, rgba(255,214,0,0.9) 0%, rgba(255,193,7,0.5) 40%, rgba(255,193,7,0) 62%)",
                  animation: "levelGlowPulse 1.1s ease-in-out infinite",
                  pointerEvents: "none",
                }}
              />
            )}
            <img
              src={STAGE_IMAGES[level.id]}
              alt={level.name}
              draggable={false}
              style={{
                width: "100%",
                display: "block",
                pointerEvents: "none",
                position: "relative",
                filter: isSelected
                  ? "drop-shadow(0 0 4px #fff) drop-shadow(0 0 9px #ffd700) drop-shadow(0 0 16px #ffc107)"
                  : "drop-shadow(0 3px 8px rgba(0,0,0,0.5))",
              }}
            />
            {level.unlocked && (
              <div
                style={{
                  position: "absolute",
                  left: "55%",
                  bottom: "60%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 1,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    color: "#f0c040",
                    fontSize: Math.max(9, Math.round(btnW * 0.075)),
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {best > 0 ? best : "尚未挑戰"}
                </div>
                {best > 0 && (
                  <div
                    style={{
                      fontSize: Math.max(9, Math.round(btnW * 0.1)),
                      letterSpacing: 1,
                      textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                    }}
                  >
                    <span style={{ color: "#f0c040" }}>
                      {"★".repeat(getStars(level.id, best))}
                    </span>
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>
                      {"★".repeat(3 - getStars(level.id, best))}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Top gradient bar — player card + leaderboard. Anchored to the real
          viewport's own top edge (not the background's box), so it's never
          covered by the level nodes and can never exceed the screen. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${Math.round(20 * scale)}px ${Math.round(30 * scale)}px`,
          background:
            "linear-gradient(180deg,rgba(0,0,0,0.7) 0%,rgba(0,0,0,0) 100%)",
        }}
      >
        {/* Player card — mascot portrait, editable name, level & XP bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: Math.round(10 * scale),
            background: "rgba(10,20,45,0.72)",
            border: "1px solid rgba(240,192,64,0.35)",
            borderRadius: 16,
            padding: Math.round(6 * scale),
            boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
            maxWidth: "66%",
          }}
        >
          <MascotHead
            size={Math.round(52 * scale)}
            radius={Math.round(10 * scale)}
          />

          <div style={{ minWidth: 0 }}>
            {editingName ? (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  autoFocus
                  maxLength={10}
                  style={{
                    width: Math.round(72 * scale),
                    fontSize: Math.round(12 * scale),
                    padding: "2px 5px",
                    borderRadius: 5,
                    border: "1px solid rgba(240,192,64,0.6)",
                    background: "rgba(0,0,0,0.45)",
                    color: "#fff",
                    fontFamily: "'Cubic11', sans-serif",
                  }}
                />
                <button
                  onPointerDown={commitName}
                  style={{
                    background: "rgba(74,222,128,0.25)",
                    border: "1px solid #4ade80",
                    color: "#4ade80",
                    borderRadius: 5,
                    fontSize: Math.round(11 * scale),
                    padding: "2px 7px",
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  ✓
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    color: "#ffe27a",
                    fontWeight: 800,
                    fontSize: Math.round(18 * scale),
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    textShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  }}
                >
                  Lv.{levelInfo.level} {profile.name}
                </span>
                <button
                  onPointerDown={() => {
                    setNameDraft(profile.name);
                    setEditingName(true);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9fb3d9",
                    cursor: "pointer",
                    fontSize: Math.round(13 * scale),
                    padding: 0,
                    touchAction: "manipulation",
                  }}
                  aria-label="修改名稱"
                >
                  ✏️
                </button>
              </div>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 4,
              }}
            >
              <div
                style={{
                  width: Math.round(120 * scale),
                  height: 9,
                  background: "rgba(255,255,255,0.18)",
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.round(levelInfo.progress * 100)}%`,
                    height: "100%",
                    background: "linear-gradient(90deg,#f0c040,#f0a020)",
                  }}
                />
              </div>
              <span
                style={{
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: Math.round(12 * scale),
                }}
              >
                {Math.round(levelInfo.progress * 100)}%
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: Math.round(6 * scale),
          }}
        >
          <button
            onPointerDown={toggleBgmMuted}
            aria-label={bgmMuted ? "開啟音樂" : "關閉音樂"}
            style={{
              color: "#f0c040",
              fontSize: Math.round(14 * scale),
              background: "rgba(0,0,0,0.5)",
              width: Math.round(30 * scale),
              height: Math.round(30 * scale),
              borderRadius: "50%",
              border: "1px solid rgba(240,192,64,0.4)",
              cursor: "pointer",
              touchAction: "manipulation",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {bgmMuted ? "🔇" : "🔊"}
          </button>
          {/* <button
            onPointerDown={() => {
              setHistory(loadHistory());
              setBoardTab(selectedLevel ?? LEVELS[0].id);
              setShowLeaderboard(true);
            }}
            style={{
              color: "#f0c040",
              fontSize: Math.round(13 * scale),
              fontWeight: 700,
              background: "rgba(0,0,0,0.5)",
              padding: `${Math.round(5 * scale)}px ${Math.round(12 * scale)}px`,
              borderRadius: 20,
              border: "1px solid rgba(240,192,64,0.4)",
              cursor: "pointer",
              fontFamily: "'Cubic11', sans-serif",
              touchAction: "manipulation",
            }}
          >
            🏆 排行榜
          </button> */}
        </div>
      </div>

      {/* Bottom bar — goal card sits to the left of the start button, both in one
          row. Anchored to the real viewport's own bottom edge, same reasoning
          as the top bar above. */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: Math.round(10 * scale),
          padding: `${Math.round(30 * scale)}px ${Math.round(30 * scale)}px`,
          background:
            "linear-gradient(0deg,rgba(0,0,0,0.8) 0%,rgba(0,0,0,0) 100%)",
        }}
      >
        {/* Goal card — grows to fill space on narrow screens but caps out on wide
            ones instead of stretching into an awkward empty-looking bar. */}
        <div
          style={{
            flex: "0 1 460px",
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: Math.round(10 * scale),
            background: "rgba(10,20,45,0.82)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 12,
            padding: Math.round(8 * scale),
          }}
        >
          <div
            style={{
              width: Math.round(34 * scale),
              height: Math.round(34 * scale),
              borderRadius: "50%",
              background: "radial-gradient(circle,#f0c040,#e0a010)",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: Math.round(17 * scale),
              boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            }}
          >
            🏆
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                color: "#fff",
                fontWeight: 700,
                fontSize: Math.round(13 * scale),
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              下一個目標：打敗自己！
            </div>
            <div
              style={{
                color: "#9fb3d9",
                fontSize: Math.round(11 * scale),
                marginTop: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              刷新你的最高分，贏得更多榮耀！
            </div>
          </div>
        </div>

        {/* Start button — mascot portrait sits inside, left of the label. Pulses
            a glowing halo once a level is selected so it's impossible to miss,
            and gives a quick press-down squash via the .start-btn:active rule. */}
        <button
          className="start-btn"
          onPointerDown={(e) => {
            e.stopPropagation();
            if (canStart && selectedLevel != null) onPlay(selectedLevel);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: Math.round(8 * scale),
            flexShrink: 0,
            padding: `${Math.round(6 * scale)}px ${Math.round(20 * scale)}px ${Math.round(6 * scale)}px ${Math.round(6 * scale)}px`,
            background: canStart
              ? "linear-gradient(135deg,#f0a020,#e06010)"
              : "rgba(60,60,60,0.7)",
            color: canStart ? "#fff" : "#666",
            border: canStart ? "2px solid #ffd700" : "2px solid transparent",
            borderRadius: Math.round(12 * scale),
            fontWeight: 700,
            fontSize: Math.round(16 * scale),
            cursor: canStart ? "pointer" : "not-allowed",
            fontFamily: "'Cubic11', sans-serif",
            whiteSpace: "nowrap",
            touchAction: "manipulation",
            textShadow: canStart ? "0 1px 4px rgba(0,0,0,0.4)" : "none",
            animation: canStart ? "startBtnPulse 1.6s ease-in-out infinite" : "none",
          }}
        >
          <div
            style={{
              filter: canStart ? "none" : "grayscale(1) brightness(0.7)",
            }}
          >
            <MascotHead
              size={Math.round(38 * scale)}
              radius={Math.round(9 * scale)}
            />
          </div>
          <span>{canStart ? "開始挑戰" : "選擇關卡"}</span>
        </button>
      </div>

      {/* Leaderboard modal — every play is recorded in localStorage. The panel is
          rankinglist_alpha.png (locked to its own aspect ratio so it never
          stretches/distorts), with the mascot avatar sitting BEHIND it (lower
          z-index) so it only shows through the frame's punched-out circular
          window instead of covering the ornate border. Sized from real vw/vh
          (see rankModalW above), so it can never exceed the screen. */}
      {showLeaderboard && (
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            setShowLeaderboard(false);
          }}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            zIndex: 50,
            padding: "6% 16px 16px",
          }}
        >
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              width: rankModalW,
              aspectRatio: "1308 / 1203",
            }}
          >
            {/* Avatar — zIndex 1, BEHIND the frame image (zIndex 2), so it's only
                visible through the frame's circular cutout. */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "15.8%",
                transform: "translate(-50%,-50%)",
                zIndex: 1,
              }}
            >
              <MascotHead size={rankAvatarSize} />
            </div>

            {/* Frame background */}
            <img
              src={rankingListBg}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                zIndex: 2,
                pointerEvents: "none",
              }}
            />

            <button
              onPointerDown={() => setShowLeaderboard(false)}
              style={{
                position: "absolute",
                right: "3%",
                top: "2%",
                zIndex: 4,
                background: "rgba(20,20,40,0.55)",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 8,
                color: "#fff",
                width: 28,
                height: 28,
                cursor: "pointer",
                fontSize: 14,
                fontFamily: "'Cubic11', sans-serif",
                touchAction: "manipulation",
              }}
            >
              ✕
            </button>

            {/* Content — kept inside the frame's inner navy area (below the
                crown/ribbon art, inside the gold border) at zIndex 3. */}
            <div
              style={{
                position: "absolute",
                left: "8%",
                right: "8%",
                top: "30%",
                bottom: "7%",
                zIndex: 3,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  textAlign: "center",
                  color: "#ffe27a",
                  fontWeight: 900,
                  fontSize: 18,
                  letterSpacing: 2,
                  textShadow: "0 2px 8px rgba(0,0,0,0.7)",
                  flexShrink: 0,
                }}
              >
                排行榜
              </div>

              {/* One tab per game — each keeps its own top-10 high-score table, since
                  raw scores aren't comparable across games with different point scales. */}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  padding: "8px 0 0",
                  flexShrink: 0,
                }}
              >
                {LEVELS.map((lvl) => {
                  const active = boardTab === lvl.id;
                  const art = RANKING_TAB_IMAGES[lvl.id];
                  return (
                    <button
                      key={lvl.id}
                      onPointerDown={() => setBoardTab(lvl.id)}
                      style={{
                        flex: 1,
                        display: "flex",
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        touchAction: "manipulation",
                      }}
                    >
                      <img
                        src={active ? art.on : art.off}
                        alt={lvl.name}
                        draggable={false}
                        style={{
                          width: "100%",
                          display: "block",
                          pointerEvents: "none",
                        }}
                      />
                    </button>
                  );
                })}
              </div>

              <div
                style={{
                  overflowY: "auto",
                  padding: "10px 4px 0",
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {(() => {
                  const activeLevel =
                    LEVELS.find((l) => l.id === boardTab) ?? LEVELS[0];
                  if (!activeLevel.unlocked) {
                    return (
                      <div
                        style={{
                          color: "#aebbdb",
                          textAlign: "center",
                          padding: "34px 10px",
                          fontSize: 16,
                        }}
                      >
                        {activeLevel.desc}
                      </div>
                    );
                  }
                  const boardRows = history
                    .filter((r) => r.levelId === boardTab)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 10);
                  if (boardRows.length === 0) {
                    return (
                      <div
                        style={{
                          color: "#aebbdb",
                          textAlign: "center",
                          padding: "34px 10px",
                          fontSize: 16,
                        }}
                      >
                        這關還沒有紀錄，快去挑戰拿高分吧！
                      </div>
                    );
                  }
                  const RANK_MEDAL = ["🥇", "🥈", "🥉"];
                  const rankFontSize = (i: number) =>
                    i === 0 ? 22 : i === 1 ? 19 : i === 2 ? 17 : 14;
                  const scoreFontSize = (i: number) =>
                    i === 0 ? 26 : i === 1 ? 22 : i === 2 ? 19 : 16;
                  const rankColor = (i: number) =>
                    i === 0
                      ? "#ffd700"
                      : i === 1
                        ? "#f2f5fb"
                        : i === 2
                          ? "#e6a662"
                          : "#dbe4f5";
                  return boardRows.map((r, i) => (
                    <div
                      key={`${r.ts}-${i}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: i < 3 ? "6px 4px" : "5px 4px",
                        borderBottom: "1px solid rgba(255,255,255,0.1)",
                      }}
                    >
                      <div
                        style={{
                          width: 26,
                          textAlign: "center",
                          lineHeight: 1,
                        }}
                      >
                        {i < 3 ? (
                          <span style={{ fontSize: rankFontSize(i) }}>
                            {RANK_MEDAL[i]}
                          </span>
                        ) : (
                          <span
                            style={{
                              color: "#aebbdb",
                              fontWeight: 700,
                              fontSize: 13,
                            }}
                          >
                            {i + 1}
                          </span>
                        )}
                      </div>
                      <div style={{ color: "#aebbdb", fontSize: 11, flex: 1 }}>
                        {formatTs(r.ts)}
                      </div>
                      <div
                        style={{
                          color: rankColor(i),
                          fontWeight: 800,
                          fontSize: scoreFontSize(i),
                          lineHeight: 1,
                        }}
                      >
                        {r.score}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
