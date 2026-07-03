import { useState, useEffect } from 'react'
import homeBg from './assets/home_bg.png'
import stage1 from './assets/stage_1.png'
import stage2 from './assets/stage_2.png'
import stage3 from './assets/stage_3.png'
import stage4 from './assets/stage_4.png'
import { LEVELS, LevelDef } from './gameData'
import { loadHistory, getBestForLevel, PlayRecord } from './leaderboard'

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
  const [, forceUpdate] = useState(0)

  // Re-read play history on mount (might have changed after a game)
  useEffect(() => { setHistory(loadHistory()) }, [])

  // Recalculate layout on resize
  useEffect(() => {
    const onResize = () => forceUpdate(n => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const vw = typeof window !== 'undefined' ? window.innerWidth  : 720
  const vh = typeof window !== 'undefined' ? window.innerHeight : 480
  const scale = Math.min(1.6, Math.max(0.7, Math.min(vw, vh) / 480))

  // Button positions (%) aligned to each circle in home_bg.png
  const levelNodes: Array<{ level: LevelDef; cx: string; cy: string }> = [
    { level: LEVELS[0], cx: '15%', cy: '68%' }, // GREEN  bottom-left
    { level: LEVELS[1], cx: '18%', cy: '33%' }, // YELLOW upper-left
    { level: LEVELS[2], cx: '74%', cy: '22%' }, // PURPLE upper-right
    { level: LEVELS[3], cx: '80%', cy: '64%' }, // INDIGO bottom-right
  ]

  const btnW = Math.round(Math.min(190, vw * 0.16))

  const canStart = selectedLevel != null && (LEVELS.find(l => l.id === selectedLevel)?.unlocked ?? false)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', fontFamily: 'sans-serif' }}>

      {/* Background image */}
      <img
        src={homeBg}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', display: 'block' }}
        alt=""
      />

      {/* Level buttons — positioned over the circles in the background art */}
      {levelNodes.map(({ level, cx, cy }) => {
        const isSelected = selectedLevel === level.id
        const best = level.unlocked ? getBestForLevel(level.id, history) : 0
        return (
          <div
            key={level.id}
            onPointerDown={() => { if (level.unlocked) setSelectedLevel(level.id) }}
            style={{
              position: 'absolute',
              left: cx, top: cy,
              transform: 'translate(-50%,-50%)',
              width: btnW,
              cursor: level.unlocked ? 'pointer' : 'default',
              touchAction: 'manipulation', userSelect: 'none',
              filter: level.unlocked ? 'none' : 'grayscale(1) brightness(0.65)',
              transition: 'transform 120ms ease',
            }}
          >
            <img
              src={STAGE_IMAGES[level.id]}
              alt={level.name}
              draggable={false}
              style={{
                width: '100%', display: 'block', pointerEvents: 'none',
                filter: isSelected ? `drop-shadow(0 0 14px ${level.accent})` : 'drop-shadow(0 3px 8px rgba(0,0,0,0.5))',
              }}
            />
            {level.unlocked && (
              <div style={{
                position: 'absolute', left: '50%', bottom: '6%',
                transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.72)', color: '#f0c040',
                fontSize: Math.max(9, Math.round(btnW * 0.075)), fontWeight: 700,
                padding: '2px 8px', borderRadius: 20,
                border: '1px solid rgba(240,192,64,0.5)',
                whiteSpace: 'nowrap', pointerEvents: 'none',
              }}>
                {best > 0 ? `🏆 ${best}` : '尚未挑戰'}
              </div>
            )}
          </div>
        )
      })}

      {/* Top gradient bar — title + leaderboard */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${Math.round(10 * scale)}px ${Math.round(16 * scale)}px`,
        background: 'linear-gradient(180deg,rgba(0,0,0,0.7) 0%,rgba(0,0,0,0) 100%)',
      }}>
        <div style={{ color: '#f0c040', fontSize: Math.round(20 * scale), fontWeight: 800, textShadow: '0 2px 8px rgba(0,0,0,0.8)', pointerEvents: 'none' }}>
          🍱 便當接接樂
        </div>
        <button
          onPointerDown={() => { setHistory(loadHistory()); setShowLeaderboard(true) }}
          style={{
            color: '#f0c040', fontSize: Math.round(13 * scale), fontWeight: 700,
            background: 'rgba(0,0,0,0.5)', padding: `${Math.round(5 * scale)}px ${Math.round(12 * scale)}px`,
            borderRadius: 20, border: '1px solid rgba(240,192,64,0.4)',
            cursor: 'pointer', fontFamily: 'sans-serif', touchAction: 'manipulation',
          }}
        >🏆 排行榜</button>
      </div>

      {/* Bottom stack — start button bar + goal banner */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: `${Math.round(10 * scale)}px ${Math.round(14 * scale)}px`,
          background: 'linear-gradient(0deg,rgba(0,0,0,0.75) 0%,rgba(0,0,0,0) 100%)',
        }}>
          <button
            onPointerDown={() => { if (canStart && selectedLevel != null) onPlay(selectedLevel) }}
            style={{
              padding: `${Math.round(11 * scale)}px ${Math.round(24 * scale)}px`,
              background: canStart ? 'linear-gradient(135deg,#f0a020,#e06010)' : 'rgba(60,60,60,0.7)',
              color: canStart ? '#fff' : '#666',
              border: canStart ? '2px solid #f0c040' : '2px solid #444',
              borderRadius: Math.round(10 * scale),
              fontWeight: 700, fontSize: Math.round(16 * scale),
              cursor: canStart ? 'pointer' : 'not-allowed',
              fontFamily: 'sans-serif', whiteSpace: 'nowrap',
              boxShadow: canStart ? '0 4px 20px rgba(240,160,32,0.5)' : 'none',
              touchAction: 'manipulation',
              textShadow: canStart ? '0 1px 4px rgba(0,0,0,0.4)' : 'none',
            }}
          >{canStart ? '開始挑戰 →' : '選擇關卡'}</button>
        </div>

        {/* Goal banner */}
        <div style={{
          textAlign: 'center',
          padding: `${Math.round(8 * scale)}px ${Math.round(14 * scale)}px`,
          background: 'rgba(0,0,0,0.75)',
          borderTop: '1px solid rgba(240,192,64,0.35)',
        }}>
          <div style={{ color: '#f0c040', fontWeight: 700, fontSize: Math.round(13 * scale) }}>
            🎯 下一個目標：打敗自己！
          </div>
          <div style={{ color: '#cbd5e1', fontSize: Math.round(11 * scale), marginTop: 2 }}>
            刷新你的最高分，贏得更多榮耀！
          </div>
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
            <div style={{ overflowY: 'auto', padding: '8px 12px' }}>
              {history.length === 0 ? (
                <div style={{ color: '#93a3c0', textAlign: 'center', padding: '30px 10px', fontSize: 13 }}>
                  還沒有遊玩紀錄，快去闖關拿高分吧！
                </div>
              ) : (
                [...history]
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 30)
                  .map((r, i) => {
                    const lvl = LEVELS.find(l => l.id === r.levelId)
                    return (
                      <div
                        key={`${r.ts}-${i}`}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '7px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <div style={{ width: 22, textAlign: 'center', color: i < 3 ? '#f0c040' : '#7a8bab', fontWeight: 800, fontSize: 13 }}>
                          {i + 1}
                        </div>
                        <div style={{ fontSize: 18 }}>{lvl?.icon ?? '🎮'}</div>
                        <div style={{ flex: 1, color: '#fff', fontSize: 12 }}>
                          <div style={{ fontWeight: 600 }}>{lvl?.name ?? `關卡 ${r.levelId}`}</div>
                          <div style={{ color: '#7a8bab', fontSize: 10 }}>{formatTs(r.ts)}</div>
                        </div>
                        <div style={{ color: '#f0c040', fontWeight: 800, fontSize: 14 }}>{r.score}</div>
                      </div>
                    )
                  })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
