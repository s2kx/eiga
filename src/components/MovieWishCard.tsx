import { useState, useEffect, useId } from 'react'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  FilmIcon,
  TrashIcon,
} from './icons'
import { rankLabel, safeHttpUrl } from '../lib/activity'

export type MovieWishPayload = {
  title: string
  startTime: string
  durationMinutes: number | null
  genre: string
  watchUrl: string
  description: string
  hasGore: boolean
  // 観たいリスト由来の場合、その項目ID（上映確定時にリストから削除する来歴）
  sourceWatchlistId: string | null
}

type Props = {
  rank: number
  payload: MovieWishPayload
  isDraft: boolean
  isFirst: boolean
  isLast: boolean
  disabled: boolean
  expanded: boolean
  onToggleExpand: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => Promise<string | null> | void
  onSave: (payload: MovieWishPayload) => Promise<string | null>
}

export default function MovieWishCard({
  rank,
  payload,
  isDraft,
  isFirst,
  isLast,
  disabled,
  expanded,
  onToggleExpand,
  onMoveUp,
  onMoveDown,
  onRemove,
  onSave,
}: Props) {
  const [title, setTitle] = useState(payload.title)
  const [duration, setDuration] = useState(
    payload.durationMinutes != null ? String(payload.durationMinutes) : ''
  )
  const [genre, setGenre] = useState(payload.genre)
  const [watchUrl, setWatchUrl] = useState(payload.watchUrl)
  const [description, setDescription] = useState(payload.description)
  const [hasGore, setHasGore] = useState(payload.hasGore)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const uid = useId()
  const titleId = `${uid}-title`
  const durationId = `${uid}-duration`
  const genreId = `${uid}-genre`
  const urlId = `${uid}-url`
  const descId = `${uid}-desc`

  // 外部更新（並び替え・サイレント再取得）に追従
  useEffect(() => {
    void Promise.resolve().then(() => {
      setTitle(payload.title)
      setDuration(payload.durationMinutes != null ? String(payload.durationMinutes) : '')
      setGenre(payload.genre)
      setWatchUrl(payload.watchUrl)
      setDescription(payload.description)
      setHasGore(payload.hasGore)
      setMessage(null)
    })
  }, [
    payload.title,
    payload.durationMinutes,
    payload.genre,
    payload.watchUrl,
    payload.description,
    payload.hasGore,
  ])

  const trimmedTitle = title.trim()
  const titleFilled = trimmedTitle.length > 0
  const durationNum = duration ? Number(duration) : NaN
  const durationOk = Number.isFinite(durationNum) && durationNum > 0
  const requiredMissing = !titleFilled || !durationOk

  const dirty =
    isDraft ||
    trimmedTitle !== payload.title ||
    duration !== (payload.durationMinutes != null ? String(payload.durationMinutes) : '') ||
    genre.trim() !== payload.genre ||
    watchUrl.trim() !== payload.watchUrl ||
    description.trim() !== payload.description ||
    hasGore !== payload.hasGore

  const handleSave = async () => {
    if (!titleFilled) {
      setMessage({ kind: 'err', text: 'タイトルを入力してください' })
      return
    }
    if (!durationOk) {
      setMessage({ kind: 'err', text: '上映時間（分）を正の整数で入力してください' })
      return
    }
    // サーバ側でも検証している。ここで弾いて分かりやすいメッセージを出す。
    if (watchUrl.trim() && !safeHttpUrl(watchUrl.trim())) {
      setMessage({ kind: 'err', text: '視聴URLは http:// または https:// で始めてください' })
      return
    }
    setSaving(true)
    const err = await onSave({
      title: trimmedTitle,
      // 開始時刻は別ページ（順位・時刻）で入力。ここでは既存値を保持。
      startTime: payload.startTime,
      durationMinutes: durationNum,
      genre: genre.trim(),
      watchUrl: watchUrl.trim(),
      description: description.trim(),
      hasGore,
      // 来歴（リスト由来か）は編集しても維持する
      sourceWatchlistId: payload.sourceWatchlistId,
    })
    setSaving(false)
    if (err) {
      setMessage({ kind: 'err', text: err })
      return
    }
    setMessage({ kind: 'ok', text: '映画情報を保存しました' })
  }

  const handleRemove = async () => {
    if (!isDraft && !confirm(`「${payload.title}」を映画希望から外しますか？`)) return
    setRemoving(true)
    await onRemove()
    setRemoving(false)
  }

  return (
    <div className="rounded-xl border border-line bg-card overflow-hidden">
      <div className="flex items-stretch">
        <button
          onClick={onToggleExpand}
          disabled={disabled}
          className="flex-1 flex items-center gap-3 px-3 py-3 text-left disabled:opacity-50 min-w-0"
        >
          <span className="shrink-0 inline-flex items-center justify-center w-12 h-9 rounded-lg bg-accent/15 text-accent text-xs font-bold">
            {rankLabel(rank)}
          </span>
          <div className="flex-1 min-w-0">
            {isDraft ? (
              <p className="text-sm font-semibold text-accent">新しい映画を入力</p>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink truncate">
                  <FilmIcon size={12} className="inline -mt-0.5 mr-1 text-accent" />
                  {payload.title}
                </p>
                <p className="text-[12px] mt-0.5 text-ink-muted truncate">
                  {payload.durationMinutes != null && `${payload.durationMinutes}分`}
                  {payload.genre && ` ・ ${payload.genre}`}
                </p>
              </>
            )}
          </div>
          <span className="shrink-0 text-ink-muted">
            {expanded ? <ChevronUpIcon size={18} /> : <ChevronDownIcon size={18} />}
          </span>
        </button>
        {!isDraft && (
          <div className="flex flex-col border-l border-line">
            <button
              onClick={onMoveUp}
              disabled={disabled || isFirst}
              aria-label="順位を上げる"
              className="flex-1 px-3 min-h-[40px] flex items-center justify-center text-ink-muted hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed border-b border-line"
            >
              <ChevronUpIcon size={18} />
            </button>
            <button
              onClick={onMoveDown}
              disabled={disabled || isLast}
              aria-label="順位を下げる"
              className="flex-1 px-3 min-h-[40px] flex items-center justify-center text-ink-muted hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronDownIcon size={18} />
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3 space-y-3 bg-bg/30">
          <div className="space-y-2.5">
            <div>
              <label htmlFor={titleId} className="block text-[11px] font-medium text-ink-muted mb-1">
                タイトル <span className="text-accent">*</span>
              </label>
              <input
                id={titleId}
                name="movie-title"
                autoComplete="off"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={disabled}
                placeholder="例: ショーシャンクの空に"
                className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor={durationId} className="block text-[11px] font-medium text-ink-muted mb-1">
                上映時間（分） <span className="text-accent">*</span>
              </label>
              <input
                id={durationId}
                name="movie-duration"
                type="number"
                min={1}
                inputMode="numeric"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={disabled}
                placeholder="例: 142"
                className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50"
              />
              <p className="text-[11px] text-ink-dim mt-1">開始時刻は次の「順位・時刻」ページで設定します。</p>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 cursor-pointer">
              <span className="text-sm text-ink">グロ描写</span>
              <input
                type="checkbox"
                checked={hasGore}
                onChange={(e) => setHasGore(e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 rounded border-line bg-bg text-accent focus:ring-accent/50 disabled:opacity-50"
              />
            </label>

            <div>
              <label htmlFor={genreId} className="block text-[11px] font-medium text-ink-muted mb-1">ジャンル</label>
              <input
                id={genreId}
                name="movie-genre"
                autoComplete="off"
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={disabled}
                placeholder="例: ドラマ / SF"
                className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor={urlId} className="block text-[11px] font-medium text-ink-muted mb-1">視聴URL</label>
              <input
                id={urlId}
                name="movie-url"
                autoComplete="off"
                type="url"
                value={watchUrl}
                onChange={(e) => setWatchUrl(e.target.value)}
                disabled={disabled}
                placeholder="https://…"
                className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50"
              />
            </div>

            <div>
              <label htmlFor={descId} className="block text-[11px] font-medium text-ink-muted mb-1">
                メモ・あらすじ
              </label>
              <textarea
                id={descId}
                name="movie-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={disabled}
                rows={3}
                placeholder="あらすじや一言など"
                className="w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent disabled:opacity-50 resize-none"
              />
            </div>
          </div>

          {requiredMissing && (
            <p className="text-[11px] text-danger bg-danger-bg/40 border border-danger/30 rounded-lg px-3 py-2 inline-flex items-center gap-1">
              <AlertIcon size={12} />
              タイトル・上映時間は必須です
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              onClick={handleRemove}
              disabled={disabled || removing}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium rounded-lg bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 disabled:opacity-60 transition-colors"
            >
              <TrashIcon size={13} />
              {removing ? '削除中…' : isDraft ? 'キャンセル' : '映画を削除'}
            </button>
            <button
              onClick={handleSave}
              disabled={disabled || saving || !dirty || requiredMissing}
              className="px-4 py-2 bg-accent text-bg text-sm font-semibold rounded-lg hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? '保存中…' : '映画情報を保存'}
            </button>
          </div>

          {message && (
            <div
              aria-live="polite"
              className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg border ${
                message.kind === 'ok'
                  ? 'bg-success-bg/60 border-success/30 text-success'
                  : 'bg-danger-bg/60 border-danger/30 text-danger'
              }`}
            >
              {message.kind === 'ok' && <CheckIcon size={14} className="mt-0.5 shrink-0" />}
              <span className="flex-1">{message.text}</span>
              <button
                onClick={() => setMessage(null)}
                aria-label="閉じる"
                className="shrink-0 text-current opacity-70 hover:opacity-100"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
