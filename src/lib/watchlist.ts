import { supabase } from './supabase'

// 個人の「観たい映画リスト」の1件
export type WatchlistItem = {
  id: string
  user_id: string
  title: string
  duration_minutes: number | null
  genre: string | null
  watch_url: string | null
  description: string | null
  has_gore: boolean
  created_at: string
  // 上映確定で消費された時刻（未消費は null）
  consumed_at: string | null
}

// 追加・更新で扱うフォーム値（id を持たない素のデータ）
export type WatchlistDraft = {
  title: string
  duration_minutes: number | null
  genre: string | null
  watch_url: string | null
  description: string | null
  has_gore: boolean
}

// 上映が確定した項目は consumed_at が入る（論理削除）。
// ロック解除で戻せるようにするため物理削除はしない。一覧では未消費だけを扱う。
export async function fetchWatchlist(userId: string): Promise<WatchlistItem[]> {
  const { data, error } = await supabase
    .from('movie_watchlist')
    .select('*')
    .eq('user_id', userId)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data as WatchlistItem[]) ?? []
}

export async function addWatchlistItem(
  userId: string,
  draft: WatchlistDraft
): Promise<WatchlistItem> {
  const { data, error } = await supabase
    .from('movie_watchlist')
    .insert({ user_id: userId, ...draft })
    .select('*')
    .single()
  if (error) throw error
  return data as WatchlistItem
}

export async function updateWatchlistItem(
  id: string,
  draft: WatchlistDraft
): Promise<void> {
  const { error } = await supabase.from('movie_watchlist').update(draft).eq('id', id)
  if (error) throw error
}

export async function deleteWatchlistItem(id: string): Promise<void> {
  const { error } = await supabase.from('movie_watchlist').delete().eq('id', id)
  if (error) throw error
}
