import { useState, useEffect, useCallback, useId, type FormEvent, type ComponentType } from 'react'
import { supabase, supabaseAdmin } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  getStoredViewMonth,
  storeViewMonth,
  isPeriodOpen,
  isPeriodPendingLock,
  type ActivityPeriod,
} from '../lib/activity'
import { PlusIcon, UsersIcon, CalendarIcon, ClockIcon, FilmIcon } from '../components/icons'
import ActivityScheduleEditor from '../components/ActivityScheduleEditor'
import PeriodAdminPanel from '../components/PeriodAdminPanel'
import PreferenceListPanel from '../components/PreferenceListPanel'
import MemberRow from '../components/MemberRow'

type Profile = {
  id: string
  username: string
  display_name: string
  is_admin: boolean
  is_viewer: boolean
  created_at: string
}

type TabKey = 'members' | 'activity' | 'period' | 'preferences'

const TABS: { key: TabKey; label: string; icon: ComponentType<{ size?: number; className?: string }> }[] = [
  { key: 'members', label: 'メンバー', icon: UsersIcon },
  { key: 'activity', label: '活動日', icon: CalendarIcon },
  { key: 'period', label: '期間', icon: ClockIcon },
  { key: 'preferences', label: '希望一覧', icon: FilmIcon },
]

const TAB_STORAGE_KEY = 'admin-active-tab'

function getStoredTab(): TabKey {
  if (typeof window === 'undefined') return 'members'
  const saved = window.sessionStorage.getItem(TAB_STORAGE_KEY)
  if (saved && TABS.some((t) => t.key === saved)) return saved as TabKey
  return 'members'
}

type Stats = {
  submitters: number
  totalPrefs: number
  movieTotal: number
  period: ActivityPeriod | null
}

export default function AdminPage() {
  const { user } = useAuth()
  const today = new Date()
  const initialMonth = getStoredViewMonth(today)
  const [viewYear, setViewYear] = useState(initialMonth.year)
  const [viewMonth, setViewMonth] = useState(initialMonth.month)
  const [activeTab, setActiveTab] = useState<TabKey>(getStoredTab)
  const [members, setMembers] = useState<Profile[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [isViewer, setIsViewer] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const usernameId = useId()
  const displayNameId = useId()
  const passwordId = useId()

  const fetchMembers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true })
    setMembers(data ?? [])
  }

  const fetchStats = useCallback(async () => {
    const { data: idData, error: rpcError } = await supabase.rpc('ensure_period', {
      p_year: viewYear,
      p_month: viewMonth + 1,
    })
    if (rpcError || !idData) {
      setStats(null)
      return
    }
    const periodId = idData as string
    const [periodRes, dateRes, wishRes] = await Promise.all([
      supabase.from('activity_periods').select('*').eq('id', periodId).single(),
      supabase
        .from('period_movie_dates')
        .select('user_id')
        .eq('period_id', periodId)
        .not('submitted_at', 'is', null),
      supabase
        .from('period_movie_wishes')
        .select('user_id')
        .eq('period_id', periodId)
        .not('submitted_at', 'is', null),
    ])
    const dates = (dateRes.data as { user_id: string }[]) ?? []
    const wishes = (wishRes.data as { user_id: string }[]) ?? []
    setStats({
      submitters: new Set(wishes.map((w) => w.user_id)).size,
      totalPrefs: dates.length,
      movieTotal: wishes.length,
      period: (periodRes.data as ActivityPeriod) ?? null,
    })
  }, [viewYear, viewMonth])

  useEffect(() => {
    void Promise.resolve().then(fetchMembers)
  }, [])

  useEffect(() => {
    void Promise.resolve().then(fetchStats)
  }, [fetchStats, activeTab])

  useEffect(() => {
    storeViewMonth(viewYear, viewMonth)
  }, [viewYear, viewMonth])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(TAB_STORAGE_KEY, activeTab)
    }
  }, [activeTab])

  const goPrevMonth = () => {
    const d = new Date(viewYear, viewMonth - 1, 1)
    const nextYear = d.getFullYear()
    const nextMonth = d.getMonth()
    setViewYear(nextYear)
    setViewMonth(nextMonth)
    storeViewMonth(nextYear, nextMonth)
  }

  const goNextMonth = () => {
    const d = new Date(viewYear, viewMonth + 1, 1)
    const nextYear = d.getFullYear()
    const nextMonth = d.getMonth()
    setViewYear(nextYear)
    setViewMonth(nextMonth)
    storeViewMonth(nextYear, nextMonth)
  }

  const goThisMonth = () => {
    const now = new Date()
    const nextYear = now.getFullYear()
    const nextMonth = now.getMonth()
    setViewYear(nextYear)
    setViewMonth(nextMonth)
    storeViewMonth(nextYear, nextMonth)
  }

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSubmitting(true)

    const email = `${username.trim()}@circle.local`

    const { data, error: signUpError } = await supabaseAdmin.auth.signUp({
      email,
      password,
    })

    if (signUpError) {
      setError(`アカウント作成に失敗しました: ${signUpError.message}`)
      setSubmitting(false)
      return
    }

    if (data.user) {
      const { error: profileError } = await supabase.from('profiles').insert({
        id: data.user.id,
        username: username.trim(),
        display_name: displayName.trim(),
        is_admin: isAdmin,
        is_viewer: isViewer,
      })

      if (profileError) {
        // 認証ユーザーだけが残るとメンバー一覧に出ず、ユーザーIDが二度と使えなくなる。
        // プロフィールを作れなかったら認証ユーザーごと取り消す。
        const { error: rollbackError } = await supabase.rpc('admin_delete_member', {
          p_user_id: data.user.id,
        })
        setError(
          rollbackError
            ? `プロフィール作成に失敗しました: ${profileError.message}（認証ユーザーの取り消しにも失敗しました: ${rollbackError.message}。同じユーザーIDでの再作成はできません）`
            : `プロフィール作成に失敗しました: ${profileError.message}（作成途中のアカウントは取り消しました）`
        )
        setSubmitting(false)
        return
      }
    }

    setSuccess(`「${displayName.trim()}」のアカウントを作成しました`)
    setUsername('')
    setDisplayName('')
    setPassword('')
    setIsAdmin(false)
    setIsViewer(false)
    setSubmitting(false)
    fetchMembers()
  }

  const adminCount = members.filter((m) => m.is_admin).length
  const periodStatus = stats?.period
    ? isPeriodOpen(stats.period)
      ? { label: '受付中', tone: 'text-success' }
      : stats.period.locked_at
        ? { label: '集計済み', tone: 'text-ink-muted' }
        : isPeriodPendingLock(stats.period)
          ? { label: '締切後', tone: 'text-danger' }
          : { label: '—', tone: 'text-ink-muted' }
    : { label: '—', tone: 'text-ink-muted' }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-bold text-ink font-display">管理ダッシュボード</h2>
        <span className="text-xs text-ink-muted">
          {viewYear}年{viewMonth + 1}月
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatCard
          label="メンバー"
          value={`${members.length}`}
          unit="人"
          sub={`管理者 ${adminCount}人`}
        />
        <StatCard
          label="今月の提出"
          value={`${stats?.submitters ?? '–'}`}
          unit="人"
          sub={members.length > 0 ? `全${members.length}人中` : undefined}
        />
        <StatCard
          label="候補日数"
          value={`${stats?.totalPrefs ?? '–'}`}
          unit="件"
          sub={stats ? `映画 ${stats.movieTotal}本` : undefined}
        />
        <StatCard
          label="期間ステータス"
          value={periodStatus.label}
          valueClassName={periodStatus.tone}
        />
      </div>

      <div className="sticky top-[57px] z-10 -mx-4 px-4 bg-bg/90 backdrop-blur border-b border-line">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = activeTab === key
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-accent text-accent'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {activeTab === 'members' && (
        <section className="space-y-5">
          <form
            onSubmit={handleCreate}
            className="bg-card rounded-xl border border-line p-5 space-y-3"
          >
            <h3 className="font-semibold text-ink">新しいメンバーを追加</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={usernameId} className="block text-xs font-medium text-ink-muted mb-1.5">
                  ユーザーID
                </label>
                <input
                  id={usernameId}
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  name="username"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  pattern="[a-zA-Z0-9_]+"
                  title="英数字とアンダースコアのみ"
                  className="w-full px-3 py-2.5 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  placeholder="例: tanaka"
                />
              </div>
              <div>
                <label htmlFor={displayNameId} className="block text-xs font-medium text-ink-muted mb-1.5">
                  表示名
                </label>
                <input
                  id={displayNameId}
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  name="name"
                  autoComplete="name"
                  className="w-full px-3 py-2.5 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  placeholder="例: 田中太郎"
                />
              </div>
              <div>
                <label htmlFor={passwordId} className="block text-xs font-medium text-ink-muted mb-1.5">
                  パスワード
                </label>
                <input
                  id={passwordId}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  name="password"
                  autoComplete="new-password"
                  minLength={6}
                  className="w-full px-3 py-2.5 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                  placeholder="6文字以上"
                />
              </div>
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 cursor-pointer pb-2.5">
                  <input
                    type="checkbox"
                    checked={isAdmin}
                    onChange={(e) => setIsAdmin(e.target.checked)}
                    className="w-4 h-4 rounded border-line bg-bg text-accent focus:ring-accent/50"
                  />
                  <span className="text-sm text-ink">管理者権限を付与</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer pb-2.5">
                  <input
                    type="checkbox"
                    checked={isViewer}
                    onChange={(e) => setIsViewer(e.target.checked)}
                    className="w-4 h-4 rounded border-line bg-bg text-accent focus:ring-accent/50"
                  />
                  <span className="text-sm text-ink">閲覧者権限を付与</span>
                </label>
              </div>
            </div>

            {error && (
              <p aria-live="polite" className="text-sm text-danger bg-danger-bg/60 border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
            {success && (
              <p aria-live="polite" className="text-sm text-success bg-success-bg/60 border border-success/30 rounded-lg px-3 py-2">
                {success}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-accent text-bg text-sm font-semibold rounded-lg hover:bg-accent-strong disabled:opacity-50 transition-colors"
            >
              <PlusIcon />
              {submitting ? '作成中…' : 'アカウントを作成'}
            </button>
          </form>

          <h3 className="text-lg font-bold text-ink pt-1">メンバー一覧</h3>

          <div className="space-y-2">
            {members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isSelf={user?.id === m.id}
                onChanged={fetchMembers}
              />
            ))}
          </div>
        </section>
      )}

      {activeTab === 'activity' && (
        <ActivityScheduleEditor
          viewYear={viewYear}
          viewMonth={viewMonth}
          onPrevMonth={goPrevMonth}
          onNextMonth={goNextMonth}
        />
      )}

      {activeTab === 'period' && (
        <PeriodAdminPanel
          year={viewYear}
          month={viewMonth + 1}
          onPrevMonth={goPrevMonth}
          onNextMonth={goNextMonth}
          onThisMonth={goThisMonth}
        />
      )}

      {activeTab === 'preferences' && (
        <PreferenceListPanel
          year={viewYear}
          month={viewMonth + 1}
          onPrevMonth={goPrevMonth}
          onNextMonth={goNextMonth}
          onThisMonth={goThisMonth}
        />
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  unit,
  sub,
  valueClassName,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
  valueClassName?: string
}) {
  return (
    <div className="bg-card rounded-xl border border-line p-3.5">
      <p className="text-[11px] text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold leading-none tabular-nums ${valueClassName ?? 'text-ink'}`}>
        {value}
        {unit && <span className="text-sm font-semibold text-ink-muted ml-0.5">{unit}</span>}
      </p>
      {sub && <p className="mt-1.5 text-[11px] text-ink-muted">{sub}</p>}
    </div>
  )
}
