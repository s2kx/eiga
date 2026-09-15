import { useEffect, useId, useState } from 'react'
import {
  CloseIcon,
  CheckIcon,
  ClockIcon,
  PinIcon,
  FilmIcon,
  UsersIcon,
  LinkIcon,
} from './icons'
import {
  formatTimeRange,
  safeHttpUrl,
  type ActivityAssignment,
  type Attendance,
  type AttendanceStatus,
} from '../lib/activity'
import HostMovieEditor from './HostMovieEditor'

type Props = {
  dateStr: string
  currentUserId: string | null
  isAdmin: boolean
  activityStart: string | null
  activityEnd: string | null
  activityRoom: string | null
  // 確定済みの場合の割り当て
  assignment: ActivityAssignment | null
  attendances: Attendance[]
  periodLocked: boolean
  onAttendanceChange: (status: AttendanceStatus | null) => Promise<string | null>
  onAssignmentSaved: () => void
  onClose: () => void
}

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']

// 匿名表示用: 自分が含まれていれば「あなたを含むN人」、そうでなければ「N人」
function describeAnonymousList(
  list: Attendance[],
  currentUserId: string | null,
  label: string
): string {
  const total = list.length
  const includesMe = !!currentUserId && list.some((a) => a.user_id === currentUserId)
  if (includesMe) {
    return total === 1 ? `あなたのみ${label}` : `あなたを含む${total}人が${label}`
  }
  return `${total}人が${label}`
}

export default function DayPreferenceModal({
  dateStr,
  currentUserId,
  isAdmin,
  activityStart,
  activityEnd,
  activityRoom,
  assignment,
  attendances,
  periodLocked,
  onAttendanceChange,
  onAssignmentSaved,
  onClose,
}: Props) {
  const [error, setError] = useState<string | null>(null)
  const [attendanceBusy, setAttendanceBusy] = useState<AttendanceStatus | 'clear' | null>(null)
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const d = new Date(dateStr + 'T00:00:00')
  const heading = `${d.getMonth() + 1}月${d.getDate()}日（${DAY_LABELS[d.getDay()]}）`
  const timeLabel = formatTimeRange(activityStart, activityEnd)

  const myAttendance = attendances.find((a) => a.user_id === currentUserId)
  const goingAttendees = attendances.filter((a) => a.status === 'going')
  const notGoingAttendees = attendances.filter((a) => a.status === 'not_going')

  const handleAttendance = async (next: AttendanceStatus) => {
    setError(null)
    const target = myAttendance?.status === next ? null : next
    setAttendanceBusy(target ?? 'clear')
    const err = await onAttendanceChange(target)
    if (err) setError(err)
    setAttendanceBusy(null)
  }

  return (
    <div className="fixed inset-0 z-30 flex items-stretch justify-center bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-3xl bg-bg flex flex-col shadow-2xl sm:my-8 sm:rounded-2xl sm:max-h-[calc(100vh-4rem)] sm:border sm:border-line"
      >
        <div className="sticky top-0 flex items-center justify-between px-5 py-4 border-b border-line bg-bg">
          <div className="min-w-0">
            <h3 id={titleId} className="text-lg font-bold text-ink font-display">
              {heading}
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {timeLabel && (
                <p className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                  <ClockIcon size={13} />
                  {timeLabel}
                </p>
              )}
              {activityRoom && (
                <p className="inline-flex items-center gap-1 text-xs font-medium text-accent">
                  <PinIcon size={13} />
                  {activityRoom}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="閉じる"
            className="p-2 -mr-2 text-ink-muted hover:text-ink transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto px-5 py-4 space-y-3"
          style={{
            paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
            overscrollBehavior: 'contain',
          }}
        >
          {error && (
            <p
              aria-live="polite"
              className="text-sm text-danger bg-danger-bg/60 border border-danger/30 rounded-lg px-3 py-2"
            >
              {error}
            </p>
          )}

          {periodLocked ? (
            <>
              <AssignmentSection
                assignment={assignment}
                isHost={!!currentUserId && assignment?.host_user_id === currentUserId}
                onAssignmentSaved={onAssignmentSaved}
              />
              <AttendanceSection
                isAuthenticated={!!currentUserId}
                isAdmin={isAdmin}
                currentUserId={currentUserId}
                myStatus={myAttendance?.status ?? null}
                going={goingAttendees}
                notGoing={notGoingAttendees}
                busy={attendanceBusy}
                onChange={handleAttendance}
              />
            </>
          ) : assignment && assignment.host_user_id ? (
            <AttendanceSection
              isAuthenticated={!!currentUserId}
              isAdmin={isAdmin}
              currentUserId={currentUserId}
              myStatus={myAttendance?.status ?? null}
              going={goingAttendees}
              notGoing={notGoingAttendees}
              busy={attendanceBusy}
              onChange={handleAttendance}
            />
          ) : (
            <div className="py-8 text-center space-y-2">
              <p className="text-sm text-ink-muted">
                希望提出受付中です。<br />
                「申請」タブから希望日を提出してください。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AssignmentSection({
  assignment,
  isHost,
  onAssignmentSaved,
}: {
  assignment: ActivityAssignment | null
  isHost: boolean
  onAssignmentSaved: () => void
}) {
  if (!assignment) {
    return (
      <div className="py-8 text-center space-y-2">
        <p className="text-sm text-ink-muted">
          この日の希望者がいなかったため、活動はありません。
        </p>
      </div>
    )
  }
  if (!assignment.host_user_id) {
    return (
      <div className="py-6 text-center space-y-2">
        <p className="text-sm text-ink-muted">主催者が割り当てられていません</p>
      </div>
    )
  }

  // href / src に入れる前にスキームを確認する
  const posterUrl = safeHttpUrl(assignment.movie_poster_url)
  const watchUrl = safeHttpUrl(assignment.movie_watch_url)

  return (
    <div className="space-y-3">
      {assignment.movie_title ? (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <FilmIcon size={14} className="text-accent" />
            <span className="text-[11px] font-semibold text-accent uppercase tracking-wider">
              上映作品
            </span>
          </div>
          <div className="bg-card border border-line rounded-xl overflow-hidden">
            {posterUrl && (
              <img
                src={posterUrl}
                alt={`${assignment.movie_title} のポスター`}
                width={1200}
                height={675}
                loading="lazy"
                className="w-full h-auto max-h-80 object-contain bg-black/20"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            )}
            <div className="px-4 py-3 space-y-2">
              <h4 className="text-xl font-bold text-ink leading-tight break-words">
                {assignment.movie_title}
              </h4>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
                {assignment.movie_start_time && (
                  <span className="inline-flex items-center gap-0.5 text-accent font-medium">
                    <ClockIcon size={11} />
                    開始 {assignment.movie_start_time.slice(0, 5)}
                  </span>
                )}
                {assignment.movie_genre && (
                  <span className="inline-flex items-center gap-0.5">
                    {assignment.movie_genre}
                  </span>
                )}
                {assignment.movie_duration_minutes !== null && (
                  <span className="inline-flex items-center gap-0.5">
                    <ClockIcon size={11} />
                    {assignment.movie_duration_minutes}分
                  </span>
                )}
                {assignment.movie_has_gore && (
                  <span className="inline-flex items-center gap-0.5 text-danger">
                    グロ描写あり
                  </span>
                )}
                {watchUrl && (
                  <a
                    href={watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-accent hover:text-accent-strong"
                  >
                    <LinkIcon size={11} />
                    視聴URL
                  </a>
                )}
              </div>
              {assignment.movie_description && (
                <p className="text-sm text-ink-muted whitespace-pre-wrap">
                  {assignment.movie_description}
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        !isHost && (
          <p className="text-sm text-ink-muted bg-card border border-line rounded-xl px-4 py-3">
            上映作品はまだ決まっていません
          </p>
        )
      )}

      {isHost && <HostMovieEditor assignment={assignment} onSaved={onAssignmentSaved} />}
    </div>
  )
}

function AttendanceSection({
  isAuthenticated,
  isAdmin,
  currentUserId,
  myStatus,
  going,
  notGoing,
  busy,
  onChange,
}: {
  isAuthenticated: boolean
  isAdmin: boolean
  currentUserId: string | null
  myStatus: AttendanceStatus | null
  going: Attendance[]
  notGoing: Attendance[]
  busy: AttendanceStatus | 'clear' | null
  onChange: (status: AttendanceStatus) => void
}) {
  const isGoingActive = myStatus === 'going'
  const isNotGoingActive = myStatus === 'not_going'

  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
          <UsersIcon size={14} />
          参加メンバー
          <span className="text-ink-muted font-normal">({going.length}人)</span>
        </span>
        {isAuthenticated && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onChange('going')}
              disabled={busy !== null}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors disabled:opacity-60 ${
                isGoingActive
                  ? 'bg-accent text-bg hover:bg-accent-strong'
                  : 'bg-card-hover text-ink border border-line hover:border-accent/50'
              }`}
            >
              {isGoingActive && <CheckIcon size={13} />}
              参加
            </button>
            <button
              onClick={() => onChange('not_going')}
              disabled={busy !== null}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors disabled:opacity-60 ${
                isNotGoingActive
                  ? 'bg-ink-muted text-bg'
                  : 'bg-card-hover text-ink-muted border border-line hover:border-ink-muted/60'
              }`}
            >
              {isNotGoingActive && <CheckIcon size={13} />}
              不参加
            </button>
          </div>
        )}
      </div>

      {going.length > 0 ? (
        <p className="text-xs text-ink-muted">
          {isAdmin
            ? going.map((a) => a.profiles?.display_name ?? '?').join('、')
            : describeAnonymousList(going, currentUserId, '参加表明')}
        </p>
      ) : (
        <p className="text-xs text-ink-dim">まだ参加表明はありません</p>
      )}

      {notGoing.length > 0 && (
        <p className="text-[11px] text-ink-dim">
          不参加:{' '}
          {isAdmin
            ? notGoing.map((a) => a.profiles?.display_name ?? '?').join('、')
            : describeAnonymousList(notGoing, currentUserId, '不参加')}
        </p>
      )}
    </div>
  )
}
