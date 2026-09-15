import { useState } from 'react'
import {
  type WatchlistItem,
  type WatchlistDraft,
  addWatchlistItem,
  updateWatchlistItem,
  deleteWatchlistItem,
} from '../lib/watchlist'
import { safeHttpUrl } from '../lib/activity'
import { AlertIcon, BookmarkIcon, FilmIcon, PlusIcon, TrashIcon } from './icons'

const EMPTY_DRAFT: WatchlistDraft = {
  title: '',
  duration_minutes: null,
  genre: null,
  watch_url: null,
  description: null,
  has_gore: false,
}

function itemToDraft(item: WatchlistItem): WatchlistDraft {
  return {
    title: item.title,
    duration_minutes: item.duration_minutes,
    genre: item.genre,
    watch_url: item.watch_url,
    description: item.description,
    has_gore: item.has_gore,
  }
}

type Props = {
  userId: string
  items: WatchlistItem[]
  onChange: (items: WatchlistItem[]) => void
}

export default function WatchlistSection({ userId, items, onChange }: Props) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 視聴URLは申請にそのまま引き継がれ、保存時にサーバ側で検証される。
  // ここで弾いておかないと、申請画面の自動保存が分かりにくいエラーで失敗する。
  const invalidUrlMessage = (draft: WatchlistDraft): string | null =>
    draft.watch_url && !safeHttpUrl(draft.watch_url)
      ? '視聴URLは http:// または https:// で始めてください'
      : null

  const handleAdd = async (draft: WatchlistDraft) => {
    setError(null)
    const urlError = invalidUrlMessage(draft)
    if (urlError) {
      setError(urlError)
      return
    }
    try {
      const created = await addWatchlistItem(userId, draft)
      onChange([created, ...items])
      setAdding(false)
    } catch (e) {
      setError(`追加に失敗しました: ${(e as Error).message}`)
    }
  }

  const handleUpdate = async (id: string, draft: WatchlistDraft) => {
    setError(null)
    const urlError = invalidUrlMessage(draft)
    if (urlError) {
      setError(urlError)
      return
    }
    try {
      await updateWatchlistItem(id, draft)
      onChange(items.map((it) => (it.id === id ? { ...it, ...draft } : it)))
      setEditingId(null)
    } catch (e) {
      setError(`更新に失敗しました: ${(e as Error).message}`)
    }
  }

  const handleDelete = async (item: WatchlistItem) => {
    if (!confirm(`「${item.title}」をリストから削除しますか？`)) return
    setError(null)
    try {
      await deleteWatchlistItem(item.id)
      onChange(items.filter((it) => it.id !== item.id))
    } catch (e) {
      setError(`削除に失敗しました: ${(e as Error).message}`)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-ink font-display inline-flex items-center gap-1.5">
          <BookmarkIcon size={15} className="text-accent" />
          観たい映画リスト
        </h3>
        <p className="text-[11px] text-ink-muted tabular-nums">{items.length}件</p>
      </div>
      <p className="text-[11px] text-ink-muted -mt-1">
        気になる映画を貯めておけます。申請の「観たい映画」入力時にここから選べます。
      </p>

      {error && (
        <p className="text-[11px] text-danger bg-danger-bg/40 border border-danger/30 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="space-y-2">
        {items.map((item) =>
          editingId === item.id ? (
            <WatchlistForm
              key={item.id}
              initial={itemToDraft(item)}
              submitLabel="保存"
              onSubmit={(draft) => handleUpdate(item.id, draft)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div
              key={item.id}
              className="rounded-xl border border-line bg-card px-3 py-2.5 flex items-start gap-3"
            >
              <FilmIcon size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-ink truncate">{item.title}</p>
                <p className="text-[12px] text-ink-muted truncate">
                  {item.duration_minutes != null && `${item.duration_minutes}分`}
                  {item.genre && `${item.duration_minutes != null ? ' ・ ' : ''}${item.genre}`}
                  {item.has_gore && <span className="text-danger"> ・ グロ描写あり</span>}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  onClick={() => {
                    setEditingId(item.id)
                    setAdding(false)
                  }}
                  className="px-2 py-1 text-[11px] font-medium rounded-md border border-line text-ink-muted hover:text-ink hover:border-accent/40 transition-colors"
                >
                  編集
                </button>
                <button
                  onClick={() => handleDelete(item)}
                  aria-label={`${item.title}を削除`}
                  className="px-2 py-1 rounded-md text-ink-muted hover:text-danger transition-colors"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </div>
          )
        )}
      </div>

      {adding ? (
        <WatchlistForm
          initial={EMPTY_DRAFT}
          submitLabel="リストに追加"
          onSubmit={handleAdd}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          onClick={() => {
            setAdding(true)
            setEditingId(null)
          }}
          className="w-full px-4 py-2.5 border border-dashed border-accent/50 text-accent text-sm font-semibold rounded-lg hover:bg-accent/10 transition-colors inline-flex items-center justify-center gap-1.5"
        >
          <PlusIcon size={16} />
          映画をリストに追加
        </button>
      )}
    </section>
  )
}

function WatchlistForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: WatchlistDraft
  submitLabel: string
  onSubmit: (draft: WatchlistDraft) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [duration, setDuration] = useState(
    initial.duration_minutes != null ? String(initial.duration_minutes) : ''
  )
  const [genre, setGenre] = useState(initial.genre ?? '')
  const [watchUrl, setWatchUrl] = useState(initial.watch_url ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [hasGore, setHasGore] = useState(initial.has_gore)
  const [saving, setSaving] = useState(false)

  const trimmedTitle = title.trim()
  const durationNum = duration ? Number(duration) : null
  // 上映時間は必須（正の整数）
  const durationValid = Number.isFinite(durationNum) && (durationNum as number) > 0
  const canSave = trimmedTitle.length > 0 && durationValid && !saving

  const handleSubmit = async () => {
    if (!canSave) return
    setSaving(true)
    await onSubmit({
      title: trimmedTitle,
      duration_minutes: durationNum,
      genre: genre.trim() || null,
      watch_url: watchUrl.trim() || null,
      description: description.trim() || null,
      has_gore: hasGore,
    })
    setSaving(false)
  }

  const field =
    'w-full px-3 py-2 bg-bg border border-line rounded-lg text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent'

  return (
    <div className="rounded-xl border border-accent/30 bg-card p-3 space-y-2.5">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="タイトル（必須）"
        className={field}
      />
      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          placeholder="上映時間（分・必須）"
          className={field}
        />
        <input
          type="text"
          value={genre}
          onChange={(e) => setGenre(e.target.value)}
          placeholder="ジャンル"
          className={field}
        />
      </div>
      <input
        type="url"
        value={watchUrl}
        onChange={(e) => setWatchUrl(e.target.value)}
        placeholder="視聴URL（任意）"
        className={field}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="メモ・あらすじ（任意）"
        className={`${field} resize-none`}
      />
      <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 cursor-pointer">
        <span className="text-sm text-ink">グロ描写</span>
        <input
          type="checkbox"
          checked={hasGore}
          onChange={(e) => setHasGore(e.target.checked)}
          className="w-4 h-4 rounded border-line bg-bg text-accent focus:ring-accent/50"
        />
      </label>
      {duration !== '' && !durationValid && (
        <p className="text-[11px] text-danger inline-flex items-center gap-1">
          <AlertIcon size={12} />
          上映時間は正の整数で入力してください
        </p>
      )}
      <div className="flex gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-2 text-xs font-medium rounded-lg border border-line text-ink-muted hover:text-ink transition-colors"
        >
          キャンセル
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          className="px-4 py-2 bg-accent text-bg text-sm font-semibold rounded-lg hover:bg-accent-strong disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? '保存中…' : submitLabel}
        </button>
      </div>
    </div>
  )
}
