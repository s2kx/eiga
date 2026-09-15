import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import {
  type ActivityPeriod,
  type MovieWish,
  type PeriodMovieDate,
  formatDeadline,
} from '../lib/activity'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  ClockIcon,
  FilmIcon,
  TrashIcon,
} from './icons'

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

type WishWithProfile = MovieWish & {
  profiles?: { display_name: string; username: string } | null
}
type DateRow = PeriodMovieDate & {
  profiles?: { display_name: string; username: string } | null
}
// 管理者の手動選択（予約）。公表はロック（集計）時まで保留される。
type ManualAssignment = {
  period_id: string
  date: string
  movie_date_id: string
  movie_wish_id: string
  user_id: string
}
// 公表済み（activity_assignments に反映済み）の日付。
// 集計後に予約が残っていても、公表されたかどうかはこれで判定する。
type PublishedAssignment = {
  date: string
  movie_wish_id: string | null
}

type ViewMode = 'date' | 'member'

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}（${DAY_LABELS[d.getDay()]}）`
}

function formatTimeShort(t: string | null): string | null {
  if (!t) return null
  return t.slice(0, 5)
}

type PreferenceListPanelProps = {
  year: number
  month: number
  onPrevMonth: () => void
  onNextMonth: () => void
  onThisMonth: () => void
}

export default function PreferenceListPanel({
  year,
  month,
  onPrevMonth,
  onNextMonth,
  onThisMonth,
}: PreferenceListPanelProps) {
  const { profile } = useAuth()
  // 管理者のみ手動操作（決定/解除/削除）・手動選択の閲覧が可能。
  // 閲覧者は読み取り専用で、手動選択(予約)は RLS により取得できない。
  const isAdmin = !!profile?.is_admin

  const [period, setPeriod] = useState<ActivityPeriod | null>(null)
  const [movies, setMovies] = useState<WishWithProfile[]>([])
  const [dates, setDates] = useState<DateRow[]>([])
  const [reservations, setReservations] = useState<ManualAssignment[]>([])
  const [published, setPublished] = useState<PublishedAssignment[]>([])
  const [view, setView] = useState<ViewMode>('date')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deletingMovieId, setDeletingMovieId] = useState<string | null>(null)
  const [decidingDate, setDecidingDate] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data: idData, error: rpcError } = await supabase.rpc('ensure_period', {
      p_year: year,
      p_month: month,
    })
    if (rpcError || !idData) {
      setError(`期間の取得に失敗しました: ${rpcError?.message ?? '不明なエラー'}`)
      setLoading(false)
      return
    }
    const periodId = idData as string

    const [periodRes, movieRes, dateRes, assignRes, publishedRes] = await Promise.all([
      supabase.from('activity_periods').select('*').eq('id', periodId).single(),
      supabase
        .from('period_movie_wishes')
        .select('*, profiles(display_name, username)')
        .eq('period_id', periodId)
        .not('submitted_at', 'is', null)
        .order('rank', { ascending: true }),
      supabase
        .from('period_movie_dates')
        .select('*, profiles(display_name, username)')
        .eq('period_id', periodId)
        .not('submitted_at', 'is', null)
        .order('date', { ascending: true })
        .order('priority', { ascending: true }),
      supabase
        .from('period_manual_assignments')
        .select('period_id, date, movie_date_id, movie_wish_id, user_id')
        .eq('period_id', periodId),
      supabase
        .from('activity_assignments')
        .select('date, movie_wish_id')
        .eq('period_id', periodId),
    ])

    // どれか一つでも失敗したら空表示ではなくエラーを出す。
    // 特に予約の取得失敗を握りつぶすと、決定済みの日が未決定として描画され、
    // 候補日の削除ボタンが復活してしまう（削除は予約を cascade で消す）。
    const failed = [periodRes, movieRes, dateRes, assignRes, publishedRes].find((r) => r.error)
    if (failed?.error) {
      setError(`申請一覧の読み込みに失敗しました: ${failed.error.message}`)
      setLoading(false)
      return
    }

    setPeriod(periodRes.data as ActivityPeriod)
    setMovies((movieRes.data as unknown as WishWithProfile[]) ?? [])
    setDates((dateRes.data as unknown as DateRow[]) ?? [])
    setReservations((assignRes.data as unknown as ManualAssignment[]) ?? [])
    setPublished((publishedRes.data as unknown as PublishedAssignment[]) ?? [])
    setLoading(false)
  }, [year, month])

  useEffect(() => {
    void Promise.resolve().then(fetchData)
  }, [fetchData])

  // 削除すると、その候補を指している手動選択（予約）も FK cascade で消える。
  // 日付別ビューでは決定済みの候補の削除ボタンを伏せているが、
  // メンバー別ビューからは削除できるので、ここで気づけるようにする。
  const reservedDateIds = useMemo(
    () => new Set(reservations.map((r) => r.movie_date_id)),
    [reservations]
  )
  const reservedWishIds = useMemo(
    () => new Set(reservations.map((r) => r.movie_wish_id)),
    [reservations]
  )

  const handleDelete = useCallback(
    async (row: DateRow, movieTitle: string) => {
      const memberLabel = row.profiles?.display_name ?? '(不明)'
      const warning = reservedDateIds.has(row.id)
        ? '\n\n※ この候補日はこの日の主催として選択済みです。削除すると選択も取り消されます。'
        : ''
      if (
        !confirm(
          `${memberLabel} さんの「${movieTitle}」の候補日 ${formatDateLabel(row.date)} を削除しますか？${warning}`
        )
      ) {
        return
      }
      setDeletingId(row.id)
      setError(null)
      const { error: rpcError } = await supabase.rpc('admin_delete_movie_date', {
        p_id: row.id,
      })
      setDeletingId(null)
      if (rpcError) {
        setError(`削除に失敗しました: ${rpcError.message}`)
        return
      }
      await fetchData()
    },
    [fetchData, reservedDateIds]
  )

  const handleDeleteMovie = useCallback(
    async (movie: WishWithProfile) => {
      const memberLabel = movie.profiles?.display_name ?? '(不明)'
      const warning = reservedWishIds.has(movie.id)
        ? '\n\n※ この映画はある日の主催として選択済みです。削除すると選択も取り消されます。'
        : ''
      if (
        !confirm(
          `${memberLabel} さんの映画「${movie.movie_title}」を削除しますか？\nこの映画の候補日もすべて削除されます。${warning}`
        )
      ) {
        return
      }
      setDeletingMovieId(movie.id)
      setError(null)
      const { error: rpcError } = await supabase.rpc('admin_delete_movie_wish', {
        p_id: movie.id,
      })
      setDeletingMovieId(null)
      if (rpcError) {
        setError(`削除に失敗しました: ${rpcError.message}`)
        return
      }
      await fetchData()
    },
    [fetchData, reservedWishIds]
  )

  const handleAssign = useCallback(
    async (row: DateRow, movieTitle: string) => {
      const memberLabel = row.profiles?.display_name ?? '(不明)'
      if (
        !confirm(
          `${formatDateLabel(row.date)} の主催を ${memberLabel} さんの「${movieTitle}」に決めますか？\n` +
            'この日は自動抽選の対象外になります。\n公表は集計（締切）時で、それまでメンバーには表示されません。'
        )
      ) {
        return
      }
      setDecidingDate(row.date)
      setError(null)
      const { error: rpcError } = await supabase.rpc('admin_assign_movie_date', {
        p_movie_date_id: row.id,
      })
      setDecidingDate(null)
      if (rpcError) {
        setError(`確定に失敗しました: ${rpcError.message}`)
        return
      }
      await fetchData()
    },
    [fetchData]
  )

  const handleClear = useCallback(
    async (date: string) => {
      if (!period) return
      if (!confirm(`${formatDateLabel(date)} の手動選択を取り消しますか？`)) {
        return
      }
      setDecidingDate(date)
      setError(null)
      // 日付だけでは期間をまたいで消えるため period_id で特定する
      const { error: rpcError } = await supabase.rpc('admin_clear_assignment', {
        p_period_id: period.id,
        p_date: date,
      })
      setDecidingDate(null)
      if (rpcError) {
        setError(`解除に失敗しました: ${rpcError.message}`)
        return
      }
      await fetchData()
    },
    [fetchData, period]
  )

  const periodLocked = !!period?.locked_at
  // 編集（手動決定・解除・削除）は管理者かつ未ロックのときのみ。
  const canEdit = isAdmin && !periodLocked

  const reservationByDate = useMemo(() => {
    const m = new Map<string, ManualAssignment>()
    for (const r of reservations) m.set(r.date, r)
    return m
  }, [reservations])

  // 公表済みの (日付 → 反映された映画) 。集計後も予約は残るので、
  // 「公表された予約」と「反映されなかった予約」をここで区別する。
  const publishedWishByDate = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const a of published) m.set(a.date, a.movie_wish_id)
    return m
  }, [published])

  const movieById = useMemo(() => {
    const m = new Map<string, WishWithProfile>()
    for (const w of movies) m.set(w.id, w)
    return m
  }, [movies])

  // 日付別: その日を候補にしている候補日（映画）を一覧
  const byDate = useMemo(() => {
    const m = new Map<string, DateRow[]>()
    for (const d of dates) {
      const list = m.get(d.date)
      if (list) list.push(d)
      else m.set(d.date, [d])
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [dates])

  // メンバー別: 映画ごとに候補日（優先順）をまとめる
  type MovieEntry = { movie: WishWithProfile; dates: DateRow[] }
  type MemberEntry = { name: string; username: string; movies: MovieEntry[] }

  const byMember = useMemo(() => {
    const datesByMovie = new Map<string, DateRow[]>()
    for (const d of dates) {
      const list = datesByMovie.get(d.movie_wish_id)
      if (list) list.push(d)
      else datesByMovie.set(d.movie_wish_id, [d])
    }
    const m = new Map<string, MemberEntry>()
    for (const w of movies) {
      let entry = m.get(w.user_id)
      if (!entry) {
        entry = {
          name: w.profiles?.display_name ?? '(不明)',
          username: w.profiles?.username ?? '',
          movies: [],
        }
        m.set(w.user_id, entry)
      }
      const ds = (datesByMovie.get(w.id) ?? []).sort((a, b) => a.priority - b.priority)
      entry.movies.push({ movie: w, dates: ds })
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  }, [movies, dates])

  const memberCount = byMember.length
  const movieTotal = movies.length
  const dateTotal = dates.length

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-ink font-display">申請一覧</h3>
        <div className="flex items-center gap-1">
          <button onClick={onPrevMonth} aria-label="前月" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-card transition-colors">
            <ChevronLeftIcon />
          </button>
          <button onClick={onThisMonth} aria-label="今月へ戻る" className="min-w-[6rem] px-3 py-1.5 text-xs font-medium rounded-lg border border-line text-ink-muted hover:text-ink hover:border-accent/40 transition-colors">
            {month}月
          </button>
          <button onClick={onNextMonth} aria-label="翌月" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-card transition-colors">
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-line p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-ink">
            {year}年{month}月
          </p>
          {period && (
            <span className="text-[11px] text-ink-muted">
              締切: {formatDeadline(period.deadline_at)}
              {period.locked_at ? '・集計済み' : ''}
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-bg border border-line py-2">
            <p className="text-[10px] text-ink-muted">提出メンバー</p>
            <p className="text-base font-bold text-ink tabular-nums">{memberCount}人</p>
          </div>
          <div className="rounded-lg bg-bg border border-line py-2">
            <p className="text-[10px] text-ink-muted">映画</p>
            <p className="text-base font-bold text-ink tabular-nums">{movieTotal}本</p>
          </div>
          <div className="rounded-lg bg-bg border border-line py-2">
            <p className="text-[10px] text-ink-muted">候補日</p>
            <p className="text-base font-bold text-ink tabular-nums">{dateTotal}件</p>
          </div>
        </div>

        <div className="inline-flex rounded-lg border border-line bg-bg p-0.5">
          <button onClick={() => setView('date')} className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${view === 'date' ? 'bg-accent text-bg' : 'text-ink-muted hover:text-ink'}`}>
            日付別
          </button>
          <button onClick={() => setView('member')} className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${view === 'member' ? 'bg-accent text-bg' : 'text-ink-muted hover:text-ink'}`}>
            メンバー別
          </button>
        </div>

        {error && (
          <p aria-live="polite" className="text-sm text-danger bg-danger-bg/60 border border-danger/30 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {loading ? (
          <div className="space-y-2"><div className="h-9 rounded-lg bg-card animate-pulse" /><div className="h-9 rounded-lg bg-card animate-pulse" /></div>
        ) : movies.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-6">この月の申請はまだありません</p>
        ) : view === 'date' ? (
          <div className="space-y-3">
            {canEdit && (
              <p className="text-[11px] text-ink-muted bg-bg border border-line rounded-lg px-3 py-2">
                各日の「決定」で主催映画を手動で選べます。選んだ内容は<span className="text-ink">集計（締切）時に自動抽選と同時に公表</span>され、それまでメンバーには表示されません。
              </p>
            )}
            {byDate.map(([date, rows]) => {
              const reservation = reservationByDate.get(date) ?? null
              // 集計後も予約は残る。公表された予約は解除できないが、
              // 反映されなかった予約は放置すると再集計で復活するので解除させる。
              const isPublished =
                !!reservation && publishedWishByDate.get(date) === reservation.movie_wish_id
              const canClear = isAdmin && (!periodLocked || !isPublished)
              return (
                <DateGroup
                  key={date}
                  date={date}
                  rows={rows}
                  movieById={movieById}
                  reservation={reservation}
                  periodLocked={periodLocked}
                  isPublished={isPublished}
                  onDelete={canEdit ? handleDelete : null}
                  onAssign={canEdit ? handleAssign : null}
                  onClear={canClear ? handleClear : null}
                  deletingId={deletingId}
                  decidingDate={decidingDate}
                />
              )
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {byMember.map((m) => (
              <MemberGroup
                key={m.username || m.name}
                entry={m}
                onDelete={canEdit ? handleDelete : null}
                onDeleteMovie={canEdit ? handleDeleteMovie : null}
                deletingId={deletingId}
                deletingMovieId={deletingMovieId}
              />
            ))}
          </div>
        )}

        {isAdmin && periodLocked && (
          <p className="text-[11px] text-ink-muted text-center">
            集計済み（ロック済み）の期間は削除できません。先にロック解除してください。
          </p>
        )}
      </div>
    </section>
  )
}

type DeleteHandler = ((row: DateRow, movieTitle: string) => void | Promise<void>) | null

function MovieMeta({ wish, showRank = false }: { wish: WishWithProfile; showRank?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-muted">
      {showRank && (
        <span className="shrink-0 inline-flex items-center justify-center px-1.5 h-5 rounded bg-accent/15 text-accent text-[10px] font-bold">
          映画 第{wish.rank}希望
        </span>
      )}
      <span className="inline-flex items-center gap-0.5 text-ink min-w-0">
        <FilmIcon size={11} className="text-accent shrink-0" />
        <span className="truncate">{wish.movie_title}</span>
      </span>
      {wish.movie_duration_minutes != null && <span className="tabular-nums">{wish.movie_duration_minutes}分</span>}
      {wish.movie_genre && <span>· {wish.movie_genre}</span>}
      {wish.movie_has_gore && <span className="text-danger">· グロ描写あり</span>}
    </div>
  )
}

type AssignHandler = ((row: DateRow, movieTitle: string) => void | Promise<void>) | null
type ClearHandler = ((date: string) => void | Promise<void>) | null

function DateGroup({
  date,
  rows,
  movieById,
  reservation,
  periodLocked,
  isPublished,
  onDelete,
  onAssign,
  onClear,
  deletingId,
  decidingDate,
}: {
  date: string
  rows: DateRow[]
  movieById: Map<string, WishWithProfile>
  reservation: ManualAssignment | null
  periodLocked: boolean
  isPublished: boolean
  onDelete: DeleteHandler
  onAssign: AssignHandler
  onClear: ClearHandler
  deletingId: string | null
  decidingDate: string | null
}) {
  const decided = !!reservation
  const decidedWishId = reservation?.movie_wish_id ?? null
  // 選択中の映画・主催者・開始時刻は、候補(row)から解決する。
  const winnerRow = decidedWishId != null
    ? rows.find((r) => r.movie_wish_id === decidedWishId) ?? null
    : null
  const decidedMovie = decidedWishId != null ? movieById.get(decidedWishId) ?? null : null
  const busy = decidingDate === date

  return (
    <div className="rounded-lg border border-line bg-bg overflow-hidden">
      <div className="px-3 py-2 bg-card border-b border-line flex items-baseline justify-between">
        <p className="text-sm font-bold text-ink">{formatDateLabel(date)}</p>
        <p className="text-[11px] text-ink-muted tabular-nums">{rows.length}本が候補</p>
      </div>

      {reservation && (
        <div
          className={`px-3 py-2 border-b flex items-center gap-2 ${
            periodLocked && !isPublished
              ? 'bg-danger-bg/40 border-danger/30'
              : 'bg-accent/10 border-accent/30'
          }`}
        >
          <CheckIcon
            size={14}
            className={`shrink-0 ${periodLocked && !isPublished ? 'text-danger' : 'text-accent'}`}
          />
          <div className="flex-1 min-w-0">
            <p
              className={`text-[11px] font-semibold ${
                periodLocked && !isPublished ? 'text-danger' : 'text-accent'
              }`}
            >
              {!periodLocked
                ? '選択済み・公表は集計時'
                : isPublished
                  ? '公表済み'
                  : '未反映 — 集計時にこの選択は反映されませんでした'}
            </p>
            <p className="text-sm text-ink truncate">
              {winnerRow?.profiles?.display_name ?? '(不明)'}
              <span className="text-ink-muted">・{decidedMovie?.movie_title ?? '映画未設定'}</span>
              {winnerRow?.start_time && (
                <span className="ml-1.5 text-[11px] text-ink-muted inline-flex items-center gap-0.5">
                  <ClockIcon size={11} />
                  {formatTimeShort(winnerRow.start_time)}
                </span>
              )}
            </p>
          </div>
          {onClear && (
            <button
              onClick={() => onClear(date)}
              disabled={busy}
              className="shrink-0 px-2 py-1 rounded-md text-[11px] font-semibold text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              取消
            </button>
          )}
        </div>
      )}

      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const movie = movieById.get(row.movie_wish_id)
          const start = formatTimeShort(row.start_time)
          const isWinner = decidedWishId != null && row.movie_wish_id === decidedWishId
          return (
            <li
              key={row.id}
              className={`px-3 py-2 flex items-start gap-2 ${isWinner ? 'bg-accent/5' : ''}`}
            >
              <span className="shrink-0 inline-flex items-center justify-center min-w-[2.75rem] px-1.5 h-6 rounded bg-accent/15 text-accent text-[11px] font-bold">
                第{row.priority}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink truncate">
                  {row.profiles?.display_name ?? '(不明)'}
                  {start && (
                    <span className="ml-2 text-[11px] font-normal text-ink-muted inline-flex items-center gap-0.5">
                      <ClockIcon size={11} />
                      {start}
                    </span>
                  )}
                </p>
                {movie ? <div className="mt-0.5"><MovieMeta wish={movie} showRank /></div> : <p className="mt-0.5 text-[11px] text-ink-dim">映画情報なし</p>}
              </div>
              {onAssign && !decided && (
                <button
                  onClick={() => onAssign(row, movie?.movie_title ?? '')}
                  disabled={busy}
                  title="この映画に確定"
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-accent border border-accent/30 hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <CheckIcon size={12} />
                  決定
                </button>
              )}
              {/* 選択済みの候補だけ削除を伏せる（削除すると予約も cascade で消えるため）。
                  同じ日の他の候補は決定後も削除できる。 */}
              {onDelete && !isWinner && (
                <button
                  onClick={() => onDelete(row, movie?.movie_title ?? '')}
                  disabled={deletingId === row.id}
                  aria-label="この候補日を削除"
                  title="この候補日を削除"
                  className="shrink-0 p-1.5 rounded-md text-ink-muted hover:text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function MemberGroup({
  entry,
  onDelete,
  onDeleteMovie,
  deletingId,
  deletingMovieId,
}: {
  entry: {
    name: string
    username: string
    movies: { movie: WishWithProfile; dates: DateRow[] }[]
  }
  onDelete: DeleteHandler
  onDeleteMovie: ((movie: WishWithProfile) => void | Promise<void>) | null
  deletingId: string | null
  deletingMovieId: string | null
}) {
  const dateCount = entry.movies.reduce((s, m) => s + m.dates.length, 0)
  return (
    <div className="rounded-lg border border-line bg-bg overflow-hidden">
      <div className="px-3 py-2 bg-card border-b border-line flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink truncate">{entry.name}</p>
          {entry.username && <p className="text-[11px] text-ink-muted truncate">@{entry.username}</p>}
        </div>
        <p className="text-[11px] text-ink-muted shrink-0 tabular-nums">
          映画{entry.movies.length}・候補日{dateCount}
        </p>
      </div>

      <ul className="px-3 py-2 space-y-2.5">
        {entry.movies.map(({ movie, dates }) => (
          <li key={movie.id}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <MovieMeta wish={movie} showRank />
              </div>
              {onDeleteMovie && (
                <button
                  onClick={() => onDeleteMovie(movie)}
                  disabled={deletingMovieId === movie.id}
                  aria-label="この映画を削除"
                  title="この映画を削除（候補日も削除）"
                  className="shrink-0 p-1 rounded-md text-ink-muted hover:text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
            {dates.length === 0 ? (
              <p className="mt-1 text-[11px] text-ink-dim">候補日なし</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {dates.map((d) => {
                  const start = formatTimeShort(d.start_time)
                  return (
                    <li key={d.id} className="flex items-center gap-2">
                      <span className="shrink-0 inline-flex items-center justify-center min-w-[2.5rem] px-1 h-5 rounded bg-accent/15 text-accent text-[10px] font-bold">
                        第{d.priority}
                      </span>
                      <span className="text-sm text-ink">{formatDateLabel(d.date)}</span>
                      {start && (
                        <span className="text-[11px] text-ink-muted inline-flex items-center gap-0.5">
                          <ClockIcon size={11} />
                          {start}
                        </span>
                      )}
                      {onDelete && (
                        <button
                          onClick={() => onDelete(d, movie.movie_title)}
                          disabled={deletingId === d.id}
                          aria-label="この候補日を削除"
                          title="この候補日を削除"
                          className="ml-auto shrink-0 p-1 rounded-md text-ink-muted hover:text-danger hover:bg-danger/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <TrashIcon size={13} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
