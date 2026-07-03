// ─── Shared game data & utilities ────────────────────────────────────────────

export interface LevelDef {
  id: number; name: string; icon: string
  desc: string; unlocked: boolean; accent: string; bg: string
}

export const LEVELS: LevelDef[] = [
  { id: 1, name: '社畜接便當', icon: '🍱', desc: '接便當、躲陷阱、正確處理來電！',
    unlocked: true,  accent: '#4ade80', bg: 'linear-gradient(135deg,#1a4a1a,#2d6b2d)' },
  { id: 2, name: '垃圾分類王', icon: '♻️',  desc: '滑動丟出垃圾，考驗你的彈道與反應力！',
    unlocked: true,  accent: '#60a5fa', bg: 'linear-gradient(135deg,#1a2a4a,#2a5298)' },
  { id: 3, name: '網銀運動會', icon: '🏃',  desc: '即將推出...',
    unlocked: false, accent: '#c084fc', bg: 'linear-gradient(135deg,#2a1a4a,#5a2a98)' },
  { id: 4, name: '加班修羅場', icon: '💼',  desc: '即將推出...',
    unlocked: false, accent: '#f97316', bg: 'linear-gradient(135deg,#4a1a0a,#8b4010)' },
]

