import { useState, useEffect, useRef } from 'react'
import homeBg from './assets/home_bg.png'
import stage1 from './assets/stage_1.png'
import stage2 from './assets/stage_2.png'
import stage3 from './assets/stage_3.png'
import stage4 from './assets/stage_4.png'
import { LEVELS, LevelDef, getStars } from './gameData'
import { loadHistory, getBestForLevel, PlayRecord } from './leaderboard'
import { loadProfile, saveProfile, getLevelInfo } from './player'
import { startLobbyBgm, stopLobbyBgm, loadBgmMuted, saveBgmMuted } from './bgm'

const STAGE_IMAGES: Record<number, string> = { 1: stage1, 2: stage2, 3: stage3, 4: stage4 }

const formatTs = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface LobbyProps {
  onPlay: (levelId: number) => void
}

export default function Lobby({ onPlay }: LobbyProps) {
  const [selectedLevel, setSelectedLevel] = useState<number | null>(1)
  const [history, setHistory] = useState<PlayRecord[]>(() => loadHistory())
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [boardTab, setBoardTab] = useState(LEVELS[0].id)
  const [profile, setProfile] = useState(() => loadProfile())
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [, forceUpdate] = useState(0)
  const [bgmMuted, setBgmMuted] = useState(() => loadBgmMuted())
  const bgmMutedRef = useRef(bgmMuted)
  useEffect(() => { bgmMutedRef.current = bgmMuted }, [bgmMuted])

  // Re-read play history on mount (might have changed after a game)
  useEffect(() => { setHistory(loadHistory()) }, [])

  // Looping chiptune BGM — only while the lobby is on screen. Browsers block audio
  // until a user gesture, so try immediately and again on the first tap/click.
  useEffect(() => {
    const tryStart = () => { if (!bgmMutedRef.current) startLobbyBgm() }
    tryStart()
    window.addEventListener('pointerdown', tryStart, { once: true })
    return () => {
      window.removeEventListener('pointerdown', tryStart)
      stopLobbyBgm()
    }
  }, [])

  const toggleBgmMuted = () => {
    const next = !bgmMuted
    setBgmMuted(next)
    saveBgmMuted(next)
    if (next) stopLobbyBgm(); else startLobbyBgm()
  }

  const levelInfo = getLevelInfo(history)

  const commitName = () => {
    const trimmed = nameDraft.trim().slice(0, 10) || profile.name
    const updated = { ...profile, name: trimmed }
    setProfile(updated)
    saveProfile(updated)
    setEditingName(false)
  }

  // Recalculate layout on resize
  useEffect(() => {
    const onResize = () => forceUpdate(n => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const vw = typeof window !== 'undefined' ? window.innerWidth  : 720
  const vh = typeof window !== 'undefined' ? window.innerHeight : 480
  const scale = Math.min(1.6, Math.max(0.7, Math.min(vw, vh) / 480))

  // home_bg.png is 1672x941. It's rendered zoomed-in and centered (both axes) over
  // the viewport, so its on-screen box depends on viewport size/aspect — computing
  // that box here (instead of hardcoding %) is what keeps the level nodes glued to
  // the four circles in the art no matter how the window is resized.
  const IMG_ASPECT = 941 / 1672
  const IMG_ZOOM = 1.12
  const imgW = vw * IMG_ZOOM
  const imgH = imgW * IMG_ASPECT
  const imgLeft = (vw - imgW) / 2
  const imgTop = (vh - imgH) / 2

  // Node positions as fractions (0..1) of the background image, sampled directly
  // from home_bg.png's four circles so they stay pinned to the art at any zoom/size.
  const levelNodes: Array<{ level: LevelDef; fx: number; fy: number }> = [
    { level: LEVELS[0], fx: 0.243, fy: 0.756 }, // GREEN  bottom-left
    { level: LEVELS[1], fx: 0.231, fy: 0.341 }, // YELLOW upper-left
    { level: LEVELS[2], fx: 0.703, fy: 0.280 }, // PURPLE upper-right
    { level: LEVELS[3], fx: 0.746, fy: 0.787 }, // BLUE   bottom-right
  ]

  const btnW = Math.round(Math.min(210, imgW * 0.16))

  const canStart = selectedLevel != null && (LEVELS.find(l => l.id === selectedLevel)?.unlocked ?? false)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', fontFamily: 'sans-serif', background: '#000' }}>

      {/* Background image — zoomed in slightly and centered on both axes so the
          four circles it depicts line up with the level nodes below at any
          viewport size (see imgW/imgH/imgLeft/imgTop above). */}
      <img
        src={homeBg}
        style={{
          position: 'absolute', left: imgLeft, top: imgTop,
          width: imgW, height: imgH,
          display: 'block',
        }}
        alt=""
      />

      <style>{`
        @keyframes levelGlowPulse {
          0%, 100% { opacity: 1;   transform: scale(1);    }
          50%      { opacity: 0.75; transform: scale(1.14); }
        }
      `}</style>

      {/* Level buttons — positioned over the circles in the background art */}
      {levelNodes.map(({ level, fx, fy }) => {
        const isSelected = selectedLevel === level.id
        const best = level.unlocked ? getBestForLevel(level.id, history) : 0
        return (
          <div
            key={level.id}
            onPointerDown={() => { if (level.unlocked) setSelectedLevel(level.id) }}
            style={{
              position: 'absolute',
              left: imgLeft + fx * imgW, top: imgTop + fy * imgH,
              transform: `translate(-50%,-50%) scale(${isSelected ? 1.18 : 1})`,
              width: btnW,
              cursor: level.unlocked ? 'pointer' : 'default',
              touchAction: 'manipulation', userSelect: 'none',
              filter: level.unlocked ? 'none' : 'grayscale(1) brightness(0.65)',
              transition: 'transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            {/* Glow halo — a soft pulsing disc behind the stage art, in a bright
                contrasting hot-pink/cyan (rather than the level's own accent, which
                tended to blend into the art) so the selection reads clearly. */}
            {isSelected && (
              <div style={{
                position: 'absolute', left: '50%', top: '50%',
                width: '92%', height: '92%',
                transform: 'translate(-50%,-50%)',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,60,180,0.85) 0%, rgba(255,60,180,0.45) 45%, rgba(255,60,180,0) 72%)',
                animation: 'levelGlowPulse 1.1s ease-in-out infinite',
                pointerEvents: 'none',
              }} />
            )}
            <img
              src={STAGE_IMAGES[level.id]}
              alt={level.name}
              draggable={false}
              style={{
                width: '100%', display: 'block', pointerEvents: 'none', position: 'relative',
                filter: isSelected
                  ? 'drop-shadow(0 0 10px #fff) drop-shadow(0 0 22px #ff3cb4) drop-shadow(0 0 42px #ff3cb4)'
                  : 'drop-shadow(0 3px 8px rgba(0,0,0,0.5))',
              }}
            />
            {level.unlocked && (
              <div style={{
                position: 'absolute', left: '50%', bottom: '5%',
                transform: 'translateX(-50%)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                pointerEvents: 'none',
              }}>
                <div style={{
                  background: 'rgba(0,0,0,0.72)', color: '#f0c040',
                  fontSize: Math.max(9, Math.round(btnW * 0.075)), fontWeight: 700,
                  padding: '2px 8px', borderRadius: 20,
                  border: '1px solid rgba(240,192,64,0.5)',
                  whiteSpace: 'nowrap',
                }}>
                  {best > 0 ? `🏆 ${best}` : '尚未挑戰'}
                </div>
                {best > 0 && (
                  <div style={{
                    fontSize: Math.max(9, Math.round(btnW * 0.1)), letterSpacing: 1,
                    textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                  }}>
                    <span style={{ color: '#f0c040' }}>{'★'.repeat(getStars(level.id, best))}</span>
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}>{'★'.repeat(3 - getStars(level.id, best))}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Top gradient bar — player card + leaderboard */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${Math.round(10 * scale)}px ${Math.round(16 * scale)}px`,
        background: 'linear-gradient(180deg,rgba(0,0,0,0.7) 0%,rgba(0,0,0,0) 100%)',
      }}>
        {/* Player card — avatar, editable name, level & XP bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: Math.round(8 * scale),
          background: 'rgba(10,20,45,0.6)', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 14, padding: Math.round(4 * scale),
          maxWidth: '62%',
        }}>
          <div style={{
            width: Math.round(38 * scale), height: Math.round(38 * scale), borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)', border: '2px solid rgba(240,192,64,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: Math.round(19 * scale), flexShrink: 0,
          }}>{profile.avatar}</div>

          <div style={{ minWidth: 0 }}>
            {editingName ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false) }}
                  autoFocus
                  maxLength={10}
                  style={{
                    width: Math.round(72 * scale), fontSize: Math.round(12 * scale),
                    padding: '2px 5px', borderRadius: 5, border: '1px solid rgba(240,192,64,0.6)',
                    background: 'rgba(0,0,0,0.45)', color: '#fff', fontFamily: 'sans-serif',
                  }}
                />
                <button
                  onPointerDown={commitName}
                  style={{
                    background: 'rgba(74,222,128,0.25)', border: '1px solid #4ade80', color: '#4ade80',
                    borderRadius: 5, fontSize: Math.round(11 * scale), padding: '2px 7px',
                    cursor: 'pointer', touchAction: 'manipulation',
                  }}
                >✓</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{
                  color: '#fff', fontWeight: 700, fontSize: Math.round(13 * scale),
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>Lv.{levelInfo.level} {profile.name}</span>
                <button
                  onPointerDown={() => { setNameDraft(profile.name); setEditingName(true) }}
                  style={{
                    background: 'none', border: 'none', color: '#9fb3d9', cursor: 'pointer',
                    fontSize: Math.round(12 * scale), padding: 0, touchAction: 'manipulation',
                  }}
                  aria-label="修改名稱"
                >✏️</button>
              </div>
            )}
            <div style={{
              marginTop: 3, width: Math.round(108 * scale), height: 7,
              background: 'rgba(255,255,255,0.18)', borderRadius: 5, overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.round(levelInfo.progress * 100)}%`, height: '100%',
                background: 'linear-gradient(90deg,#f0c040,#f0a020)',
              }} />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: Math.round(6 * scale) }}>
          <button
            onPointerDown={toggleBgmMuted}
            aria-label={bgmMuted ? '開啟音樂' : '關閉音樂'}
            style={{
              color: '#f0c040', fontSize: Math.round(14 * scale),
              background: 'rgba(0,0,0,0.5)', width: Math.round(30 * scale), height: Math.round(30 * scale),
              borderRadius: '50%', border: '1px solid rgba(240,192,64,0.4)',
              cursor: 'pointer', touchAction: 'manipulation',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >{bgmMuted ? '🔇' : '🔊'}</button>
          <button
            onPointerDown={() => { setHistory(loadHistory()); setBoardTab(selectedLevel ?? LEVELS[0].id); setShowLeaderboard(true) }}
            style={{
              color: '#f0c040', fontSize: Math.round(13 * scale), fontWeight: 700,
              background: 'rgba(0,0,0,0.5)', padding: `${Math.round(5 * scale)}px ${Math.round(12 * scale)}px`,
              borderRadius: 20, border: '1px solid rgba(240,192,64,0.4)',
              cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
            }}
          >🏆 排行榜</button>
        </div>
      </div>

      {/* Bottom stack — goal card + start button (with player avatar) */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', flexDirection: 'column', gap: Math.round(8 * scale) }}>
        {/* Goal card */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: Math.round(10 * scale),
          margin: `0 ${Math.round(14 * scale)}px`,
          background: 'rgba(10,20,45,0.82)', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 12, padding: Math.round(8 * scale),
        }}>
          <div style={{
            width: Math.round(34 * scale), height: Math.round(34 * scale), borderRadius: '50%',
            background: 'radial-gradient(circle,#f0c040,#e0a010)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: Math.round(17 * scale), boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          }}>🏆</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#fff', fontWeight: 700, fontSize: Math.round(13 * scale) }}>
              下一個目標：打敗自己！
            </div>
            <div style={{ color: '#9fb3d9', fontSize: Math.round(11 * scale), marginTop: 1 }}>
              刷新你的最高分，贏得更多榮耀！
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: Math.round(8 * scale),
          padding: `${Math.round(10 * scale)}px ${Math.round(14 * scale)}px`,
          background: 'linear-gradient(0deg,rgba(0,0,0,0.75) 0%,rgba(0,0,0,0) 100%)',
        }}>
          <div style={{
            width: Math.round(38 * scale), height: Math.round(38 * scale), borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)', border: `2px solid #000`,
            boxShadow: '0 0 0 2px rgba(240,192,64,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: Math.round(19 * scale), flexShrink: 0,
          }}>{profile.avatar}</div>
          <button
            onPointerDown={() => { if (canStart && selectedLevel != null) onPlay(selectedLevel) }}
            style={{
              padding: `${Math.round(11 * scale)}px ${Math.round(24 * scale)}px`,
              background: canStart ? 'linear-gradient(135deg,#f0a020,#e06010)' : 'rgba(60,60,60,0.7)',
              color: canStart ? '#fff' : '#666',
              border: canStart ? '3px solid #000' : '2px solid #444',
              boxShadow: canStart ? '0 0 0 2px #f0c040, 0 4px 20px rgba(240,160,32,0.5)' : 'none',
              borderRadius: Math.round(10 * scale),
              fontWeight: 700, fontSize: Math.round(16 * scale),
              cursor: canStart ? 'pointer' : 'not-allowed',
              fontFamily: 'sans-serif', whiteSpace: 'nowrap',
              touchAction: 'manipulation',
              textShadow: canStart ? '0 1px 4px rgba(0,0,0,0.4)' : 'none',
            }}
          >{canStart ? '開始挑戰 →' : '選擇關卡'}</button>
        </div>
      </div>

      {/* Leaderboard modal — every play is recorded in localStorage */}
      {showLeaderboard && (
        <div
          onPointerDown={() => setShowLeaderboard(false)}
          style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 50, padding: 20,
          }}
        >
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 340, maxHeight: '78%',
              background: 'linear-gradient(160deg,#12203f,#0a1730)',
              border: '2px solid rgba(240,192,64,0.5)', borderRadius: 16,
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderBottom: '1px solid rgba(240,192,64,0.3)',
            }}>
              <div style={{ color: '#f0c040', fontWeight: 800, fontSize: 18 }}>🏆 排行榜</div>
              <button
                onPointerDown={() => setShowLeaderboard(false)}
                style={{
                  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.3)',
                  borderRadius: 8, color: '#fff', width: 28, height: 28, cursor: 'pointer',
                  fontFamily: 'sans-serif', touchAction: 'manipulation',
                }}
              >✕</button>
            </div>

            {/* One tab per game — each keeps its own top-10 high-score table, since
                raw scores aren't comparable across games with different point scales. */}
            <div style={{ display: 'flex', gap: 4, padding: '10px 12px 0' }}>
              {LEVELS.map(lvl => {
                const active = boardTab === lvl.id
                return (
                  <button
                    key={lvl.id}
                    onPointerDown={() => setBoardTab(lvl.id)}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      padding: '6px 4px', borderRadius: 10,
                      background: active ? 'rgba(240,192,64,0.22)' : 'rgba(255,255,255,0.05)',
                      border: active ? '1px solid rgba(240,192,64,0.7)' : '1px solid rgba(255,255,255,0.1)',
                      color: active ? '#f0c040' : '#93a3c0',
                      fontWeight: active ? 800 : 600, fontSize: 11,
                      cursor: 'pointer', touchAction: 'manipulation', whiteSpace: 'nowrap', overflow: 'hidden',
                    }}
                  >
                    <span style={{ fontSize: 14 }}>{lvl.icon}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{lvl.name}</span>
                  </button>
                )
              })}
            </div>

            <div style={{ overflowY: 'auto', padding: '10px 12px', minHeight: 120 }}>
              {(() => {
                const activeLevel = LEVELS.find(l => l.id === boardTab) ?? LEVELS[0]
                if (!activeLevel.unlocked) {
                  return (
                    <div style={{ color: '#93a3c0', textAlign: 'center', padding: '30px 10px', fontSize: 13 }}>
                      {activeLevel.desc}
                    </div>
                  )
                }
                const boardRows = history
                  .filter(r => r.levelId === boardTab)
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 10)
                if (boardRows.length === 0) {
                  return (
                    <div style={{ color: '#93a3c0', textAlign: 'center', padding: '30px 10px', fontSize: 13 }}>
                      這關還沒有紀錄，快去挑戰拿高分吧！
                    </div>
                  )
                }
                const RANK_MEDAL = ['🥇', '🥈', '🥉']
                const rankFontSize = (i: number) => (i === 0 ? 26 : i === 1 ? 21 : i === 2 ? 18 : 13)
                const rankColor = (i: number) => (i === 0 ? '#ffd700' : i === 1 ? '#e5eaf2' : i === 2 ? '#e0a870' : '#c7d2e6')
                return boardRows.map((r, i) => (
                  <div
                    key={`${r.ts}-${i}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: i < 3 ? '9px 6px' : '6px 6px',
                      borderBottom: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <div style={{ width: 30, textAlign: 'center', lineHeight: 1 }}>
                      {i < 3
                        ? <span style={{ fontSize: rankFontSize(i) }}>{RANK_MEDAL[i]}</span>
                        : <span style={{ color: '#7a8bab', fontWeight: 700, fontSize: 13 }}>{i + 1}</span>}
                    </div>
                    <div style={{ color: '#7a8bab', fontSize: 11, flex: 1 }}>{formatTs(r.ts)}</div>
                    <div style={{ color: rankColor(i), fontWeight: 800, fontSize: rankFontSize(i), lineHeight: 1 }}>
                      {r.score}
                    </div>
                  </div>
                ))
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
