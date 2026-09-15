-- ============================================
-- 035_security_and_assignment_fixes.sql
-- コードレビューで見つかった問題をまとめて修正する。
--
--  (1) 権限昇格の封鎖
--      - profiles_update（WITH CHECK 無し＝自分の is_admin を自分で立てられた）を撤去。
--        プロフィールの変更は admin_update_member（security definer）経由のみ。
--      - profiles_insert（with check (true)＝自分でサインアップして管理者行を作れた）を
--        管理者のみに制限。
--        ※ Supabase ダッシュボードで「Allow new users to sign up」を無効にすること。
--          アカウント作成は管理者画面（signUp → profiles insert）だけで行う。
--  (2) ensure_period に期間の範囲制限（現在から前後24か月）を入れる。
--  (3) admin_delete_movie_wish の rank 振り直しを2パス化（unique 制約違反の回避）。
--  (4) 手動選択（予約）まわり
--      - admin_assign_movie_date に for update を戻し、ロック確定後の割り込みを防ぐ。
--      - 同じ映画を2日に予約できないよう unique 制約で担保する。
--      - 集計時に予約を削除しない（公表後も記録として残す）。
--        これにより「ロック解除 → 再集計」で同じ手動選択が復元される。
--      - 反映できなかった予約も残るので、管理者が気づいて取り消せる。
--      - admin_clear_assignment を (period_id, date) で特定するよう変更。
--  (5) set_my_application が申請を作り直すとき、管理者の予約を取り直す。
--      （日付＋映画タイトルが一致する候補日へ貼り替える）
--  (6) ウォッチリストの消費を論理削除（consumed_at）に変更し、
--      ロック解除で復活させる。031 のコメントどおりの挙動にする。
--  (7) 視聴URLのスキーマ検証（http/https のみ）。
-- ============================================

-- --------------------------------------------
-- (1) 権限昇格の封鎖
-- --------------------------------------------

-- profiles のポリシーから profiles を直接参照すると、後で profiles_select を
-- 絞ったときに再帰になる。security definer のヘルパ越しに判定する。
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

grant execute on function public.current_user_is_admin() to authenticated;

-- 自分のプロフィールを自分で更新する経路は使っていない（変更は admin_update_member のみ）。
-- USING だけのポリシーは UPDATE では WITH CHECK も兼ねるため、
-- 「自分の行なら全カラム更新可」＝ is_admin の自己付与を許してしまっていた。
drop policy if exists "profiles_update" on public.profiles;

-- プロフィール行の作成は管理者のみ。
-- （管理者画面が signUp 直後に対象ユーザーの行を作る。作るのは管理者自身のセッション。）
drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert_admin" on public.profiles
  for insert to authenticated
  with check (public.current_user_is_admin());

-- 既に self-service で管理者権限を取得した行がないか確認するための参考クエリ:
--   select id, username, display_name, is_admin, is_viewer, created_at
--   from public.profiles where is_admin order by created_at;
-- 想定外の行があれば admin_update_member で is_admin を外すこと。
--
-- 【初期セットアップ】管理者が1人も居ない状態では、この挿入ポリシーにより
-- 画面からメンバーを作れない（最初の1人を作れる管理者が居ないため）。
-- まっさらな環境では最初の管理者だけ SQL Editor で直接作ること:
--   -- 1) Authentication > Users で <ユーザーID>@circle.local のユーザーを作る
--   -- 2) その uid を使って:
--   --    insert into public.profiles (id, username, display_name, is_admin)
--   --    values ('<uid>', '<ユーザーID>', '<表示名>', true);
-- 以降は管理画面から追加できる。
do $$
begin
  if not exists (select 1 from public.profiles where is_admin) then
    raise warning '管理者が居ません。最初の管理者は SQL で直接作成してください（035 冒頭のコメント参照）。';
  end if;
end $$;

-- --------------------------------------------
-- (7) URL 検証ヘルパ
-- --------------------------------------------

-- 空文字/NULL は NULL を返す。http(s) 以外のスキーム（javascript: など）は例外。
create or replace function public.validate_http_url(p_url text)
returns text
language plpgsql
immutable
as $$
declare
  v text;
begin
  v := nullif(trim(coalesce(p_url, '')), '');
  if v is null then
    return null;
  end if;
  if v !~* '^https?://[^[:space:]]+$' then
    raise exception 'url must start with http:// or https:// (got %)', v;
  end if;
  return v;
end;
$$;

grant execute on function public.validate_http_url(text) to authenticated;

-- 検証を入れる前に保存された不正なURL（"example.com" など）を落としておく。
-- 申請画面は編集のたびに set_my_application を呼ぶ自動保存なので、
-- 既存行に不正なURLが残っていると、そのメンバーは以後一切保存できなくなる。
update public.period_movie_wishes
  set movie_watch_url = null
  where movie_watch_url is not null
    and movie_watch_url !~* '^https?://[^[:space:]]+$';

update public.movie_watchlist
  set watch_url = null
  where watch_url is not null
    and watch_url !~* '^https?://[^[:space:]]+$';

update public.activity_assignments
  set movie_watch_url = null
  where movie_watch_url is not null
    and movie_watch_url !~* '^https?://[^[:space:]]+$';

update public.activity_assignments
  set movie_poster_url = null
  where movie_poster_url is not null
    and movie_poster_url !~* '^https?://[^[:space:]]+$';

-- --------------------------------------------
-- (6) ウォッチリストの消費を論理削除にする
-- --------------------------------------------

alter table public.movie_watchlist
  add column if not exists consumed_at timestamptz,
  add column if not exists consumed_period_id uuid
    references public.activity_periods(id) on delete set null;

create index if not exists movie_watchlist_active_idx
  on public.movie_watchlist(user_id, created_at desc)
  where consumed_at is null;

-- --------------------------------------------
-- (2) ensure_period: 期間の範囲を制限する
-- --------------------------------------------

create or replace function public.ensure_period(p_year int, p_month int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_default_deadline timestamptz;
  v_target date;
  v_now date;
begin
  if p_year is null or p_month is null or p_month < 1 or p_month > 12 then
    raise exception 'invalid period %-%', p_year, p_month;
  end if;

  select id into v_id from public.activity_periods
    where year = p_year and month = p_month;
  if v_id is not null then
    return v_id;
  end if;

  -- 既存が無いときだけ範囲を検査する（過去の期間の閲覧は妨げない）。
  v_target := make_date(p_year, p_month, 1);
  v_now := date_trunc('month', (now() at time zone 'Asia/Tokyo'))::date;
  if v_target < (v_now - interval '24 months') or v_target > (v_now + interval '24 months') then
    raise exception 'period %-% is out of range', p_year, p_month;
  end if;

  v_default_deadline := (
    (v_target::timestamp - interval '12 hours')
    at time zone 'Asia/Tokyo'
  );

  insert into public.activity_periods (year, month, deadline_at)
  values (p_year, p_month, v_default_deadline)
  on conflict (year, month) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.activity_periods
      where year = p_year and month = p_month;
  end if;
  return v_id;
end;
$$;

grant execute on function public.ensure_period(int, int) to authenticated;

-- --------------------------------------------
-- (3) admin_delete_movie_wish: rank 振り直しを2パス化
-- --------------------------------------------

create or replace function public.admin_delete_movie_wish(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_row public.period_movie_wishes%rowtype;
  v_period public.activity_periods%rowtype;
  v_offset int;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_caller and is_admin) then
    raise exception 'admin only';
  end if;

  select * into v_row from public.period_movie_wishes where id = p_id;
  if not found then
    raise exception 'movie wish not found';
  end if;

  select * into v_period from public.activity_periods where id = v_row.period_id;
  if found and v_period.locked_at is not null then
    raise exception 'period is already locked';
  end if;

  delete from public.period_movie_wishes where id = p_id;

  -- unique (user_id, period_id, rank) は行ごとに即時検査されるため、1文で詰め直すと
  -- 行の処理順によっては生きている行と衝突して 23505 で全体が巻き戻る。
  -- いったん衝突しない範囲へ退避してから 1..N に振り直す。
  -- （check (rank >= 1) があるので負値ではなく上方向へ逃がす）
  select coalesce(max(rank), 0) into v_offset
  from public.period_movie_wishes
  where period_id = v_row.period_id
    and user_id = v_row.user_id;

  if v_offset = 0 then
    return;
  end if;

  update public.period_movie_wishes
  set rank = rank + v_offset
  where period_id = v_row.period_id
    and user_id = v_row.user_id;

  with renumbered as (
    select id, row_number() over (order by rank, created_at) as new_rank
    from public.period_movie_wishes
    where period_id = v_row.period_id
      and user_id = v_row.user_id
  )
  update public.period_movie_wishes w
  set rank = renumbered.new_rank
  from renumbered
  where w.id = renumbered.id;
end;
$$;

grant execute on function public.admin_delete_movie_wish(uuid) to authenticated;

-- --------------------------------------------
-- (4) 手動選択（予約）
-- --------------------------------------------

-- 同じ映画を複数の日に予約できないことを制約で担保する
-- （EXISTS チェックだけでは同時実行で抜けられる）。
-- 制約を張る前に、既に重複している予約があれば古い方だけ残す。
delete from public.period_manual_assignments pma
using public.period_manual_assignments other
where pma.period_id = other.period_id
  and pma.movie_wish_id = other.movie_wish_id
  and (pma.created_at, pma.date) > (other.created_at, other.date);

create unique index if not exists period_manual_assignments_movie_key
  on public.period_manual_assignments(period_id, movie_wish_id);

create or replace function public.admin_assign_movie_date(p_movie_date_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_pmd public.period_movie_dates%rowtype;
  v_period public.activity_periods%rowtype;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_caller and is_admin) then
    raise exception 'admin only';
  end if;

  select * into v_pmd from public.period_movie_dates where id = p_movie_date_id;
  if not found then
    raise exception 'candidate date not found';
  end if;

  -- 集計（ロック）と直列化する。for update を取ってからロック状態を読み直す。
  select * into v_period from public.activity_periods
    where id = v_pmd.period_id for update;
  if not found then
    raise exception 'period not found';
  end if;
  if v_period.locked_at is not null then
    raise exception 'period is already locked';
  end if;

  if v_pmd.submitted_at is null then
    raise exception 'candidate date is not submitted';
  end if;
  if v_pmd.start_time is null then
    raise exception 'candidate date has no start time';
  end if;
  if not public.is_activity_day(v_pmd.date) then
    raise exception 'date % is not an activity day', v_pmd.date;
  end if;

  -- 同じ映画を別の日に選択済みなら弾く（unique 制約の手前で分かりやすく落とす）。
  if exists (
    select 1 from public.period_manual_assignments
    where period_id = v_pmd.period_id
      and movie_wish_id = v_pmd.movie_wish_id
      and date <> v_pmd.date
  ) then
    raise exception 'movie is already selected on another date';
  end if;

  insert into public.period_manual_assignments (
    period_id, date, movie_date_id, movie_wish_id, user_id
  ) values (
    v_pmd.period_id, v_pmd.date, v_pmd.id, v_pmd.movie_wish_id, v_pmd.user_id
  )
  on conflict (period_id, date) do update set
    movie_date_id = excluded.movie_date_id,
    movie_wish_id = excluded.movie_wish_id,
    user_id = excluded.user_id,
    created_at = now();
end;
$$;

grant execute on function public.admin_assign_movie_date(uuid) to authenticated;

-- 解除は (period_id, date) で特定する。date だけでは期間をまたいで消える。
drop function if exists public.admin_clear_assignment(date);

create or replace function public.admin_clear_assignment(p_period_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_row public.period_manual_assignments%rowtype;
  v_period public.activity_periods%rowtype;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_caller and is_admin) then
    raise exception 'admin only';
  end if;

  select * into v_row from public.period_manual_assignments
    where period_id = p_period_id and date = p_date;
  if not found then
    return;
  end if;

  select * into v_period from public.activity_periods where id = v_row.period_id;

  -- ロック済みでも「公表されなかった予約」は取り消せる（放置すると再集計で復活するため）。
  -- 公表済みの予約を消したい場合は先にロック解除すること。
  if found and v_period.locked_at is not null then
    if exists (
      select 1 from public.activity_assignments a
      where a.period_id = v_row.period_id
        and a.date = v_row.date
        and a.movie_wish_id = v_row.movie_wish_id
    ) then
      raise exception 'period is already locked';
    end if;
  end if;

  delete from public.period_manual_assignments
    where period_id = p_period_id and date = p_date;
end;
$$;

grant execute on function public.admin_clear_assignment(uuid, date) to authenticated;

-- --------------------------------------------
-- (5) set_my_application: 管理者の予約を取り直す ＋ URL 検証
-- --------------------------------------------

create or replace function public.set_my_application(
  p_period_id uuid,
  p_movies jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.activity_periods%rowtype;
  v_user uuid;
  v_movie jsonb;
  v_date_elem jsonb;
  v_position int := 0;
  v_priority int;
  v_title text;
  v_duration int;
  v_src uuid;
  v_movie_id uuid;
  v_date date;
  v_start time;
  v_movie_dates date[];
  v_saved_reservations jsonb;
  v_res jsonb;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select * into v_period from public.activity_periods where id = p_period_id;
  if not found then
    raise exception 'period not found';
  end if;
  if v_period.locked_at is not null then
    raise exception 'period is already locked';
  end if;
  if v_period.deadline_at <= now() then
    raise exception 'period deadline has passed';
  end if;

  -- 管理者が選んだ日を控えておく（申請を作り直すと FK cascade で消えるため）。
  -- 日付＋映画タイトルで同じものを指し直す。
  select coalesce(
    jsonb_agg(jsonb_build_object('date', pma.date, 'title', mw.movie_title)),
    '[]'::jsonb
  )
  into v_saved_reservations
  from public.period_manual_assignments pma
  join public.period_movie_wishes mw on mw.id = pma.movie_wish_id
  where pma.period_id = p_period_id
    and pma.user_id = v_user;

  delete from public.period_movie_dates
    where user_id = v_user and period_id = p_period_id;
  delete from public.period_movie_wishes
    where user_id = v_user and period_id = p_period_id;

  if p_movies is not null and jsonb_typeof(p_movies) = 'array' then
    for v_movie in select * from jsonb_array_elements(p_movies) loop
      v_title := nullif(trim(coalesce(v_movie->>'title', '')), '');
      if v_title is null then
        raise exception 'movie title is required';
      end if;

      v_duration := nullif(v_movie->>'duration_minutes', '')::int;
      if v_duration is null or v_duration <= 0 then
        raise exception 'duration_minutes must be positive for %', v_title;
      end if;

      v_src := nullif(v_movie->>'source_watchlist_id', '')::uuid;
      if v_src is not null and not exists (
        select 1 from public.movie_watchlist where id = v_src and user_id = v_user
      ) then
        v_src := null;
      end if;

      v_position := v_position + 1;
      insert into public.period_movie_wishes (
        period_id, user_id, rank,
        movie_title, movie_duration_minutes,
        movie_genre, movie_watch_url, movie_description, movie_has_gore,
        source_watchlist_id
      ) values (
        p_period_id, v_user, v_position,
        v_title, v_duration,
        nullif(trim(coalesce(v_movie->>'genre', '')), ''),
        public.validate_http_url(v_movie->>'watch_url'),
        nullif(trim(coalesce(v_movie->>'description', '')), ''),
        coalesce((v_movie->>'has_gore')::boolean, false),
        v_src
      )
      returning id into v_movie_id;

      -- 候補日は映画ごとに第1から採番（優先順＝映画内の並び順）
      v_priority := 0;
      v_movie_dates := array[]::date[];
      if v_movie ? 'dates' and jsonb_typeof(v_movie->'dates') = 'array' then
        for v_date_elem in select * from jsonb_array_elements(v_movie->'dates') loop
          v_date := nullif(v_date_elem->>'date', '')::date;
          if v_date is null then
            continue;
          end if;
          if not public.is_activity_day(v_date) then
            raise exception 'date % is not an activity day', v_date;
          end if;
          if extract(year from v_date)::int != v_period.year
             or extract(month from v_date)::int != v_period.month then
            raise exception 'date % is not in period', v_date;
          end if;
          -- 同じ映画内での同日重複だけ弾く（別の映画とは同じ日でもよい）
          if v_date = any(v_movie_dates) then
            continue;
          end if;
          v_movie_dates := array_append(v_movie_dates, v_date);

          v_start := nullif(v_date_elem->>'start_time', '')::time;

          v_priority := v_priority + 1;
          insert into public.period_movie_dates (
            period_id, user_id, movie_wish_id, date, priority, start_time
          ) values (
            p_period_id, v_user, v_movie_id, v_date, v_priority, v_start
          );
        end loop;
      end if;
    end loop;
  end if;

  -- 控えておいた手動選択を、作り直した候補日へ貼り替える。
  -- 同じ日・同じタイトルが残っていなければ復元されない（その選択は実体を失ったため）。
  for v_res in select * from jsonb_array_elements(v_saved_reservations) loop
    insert into public.period_manual_assignments (
      period_id, date, movie_date_id, movie_wish_id, user_id
    )
    select p_period_id, s.date, s.id, s.movie_wish_id, s.user_id
    from (
      select pmd.date, pmd.id, pmd.movie_wish_id, pmd.user_id
      from public.period_movie_dates pmd
      join public.period_movie_wishes mw on mw.id = pmd.movie_wish_id
      where pmd.period_id = p_period_id
        and pmd.user_id = v_user
        and pmd.date = (v_res->>'date')::date
        and mw.movie_title = (v_res->>'title')
        -- 同じ映画を2日に予約することはできない（unique 制約）
        and not exists (
          select 1 from public.period_manual_assignments x
          where x.period_id = p_period_id and x.movie_wish_id = pmd.movie_wish_id
        )
      order by mw.rank, pmd.priority
      limit 1
    ) s
    on conflict (period_id, date) do nothing;
  end loop;
end;
$$;

grant execute on function public.set_my_application(uuid, jsonb) to authenticated;

-- --------------------------------------------
-- (7) update_my_assignment_movie: URL 検証
-- --------------------------------------------

create or replace function public.update_my_assignment_movie(
  p_date date,
  p_title text,
  p_description text,
  p_duration_minutes int,
  p_genre text,
  p_poster_url text,
  p_watch_url text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_host uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select host_user_id into v_host from public.activity_assignments where date = p_date;
  if v_host is null then
    raise exception 'assignment not found or no host';
  end if;
  if v_host != v_user then
    raise exception 'only host can edit movie';
  end if;

  update public.activity_assignments
  set movie_title = nullif(trim(p_title), ''),
      movie_description = nullif(trim(coalesce(p_description, '')), ''),
      movie_duration_minutes = p_duration_minutes,
      movie_genre = nullif(trim(coalesce(p_genre, '')), ''),
      movie_poster_url = public.validate_http_url(p_poster_url),
      movie_watch_url = public.validate_http_url(p_watch_url),
      movie_updated_at = now()
  where date = p_date;
end;
$$;

grant execute on function public.update_my_assignment_movie(date, text, text, int, text, text, text) to authenticated;

-- --------------------------------------------
-- (4)(6) _lock_activity_period:
--   - 予約は公表後も残す（ロック解除→再集計で同じ選択が復元される）
--   - ウォッチリストは論理削除にして、解除で戻せるようにする
-- --------------------------------------------

create or replace function public._lock_activity_period(
  p_period_id uuid,
  p_ignore_deadline boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.activity_periods%rowtype;
  v_first_day date;
  v_last_day date;
  v_max_priority int;
  v_priority int;
  v_date date;
  v_winner public.period_movie_dates%rowtype;
  v_wish public.period_movie_wishes%rowtype;
  v_scheduled uuid[];
begin
  select * into v_period from public.activity_periods where id = p_period_id for update;
  if not found then
    raise exception 'period not found';
  end if;
  if v_period.locked_at is not null then
    return;
  end if;
  if not p_ignore_deadline and v_period.deadline_at > now() then
    return;
  end if;

  v_first_day := make_date(v_period.year, v_period.month, 1);
  v_last_day := (v_first_day + interval '1 month - 1 day')::date;

  -- 手動選択(予約)を反映。候補が有効（提出済み・時刻あり・活動日が空き）なものだけ。
  -- 反映できなかった予約は削除せずに残す（管理者が一覧で気づいて取り消せる）。
  insert into public.activity_assignments (
    date, period_id, host_user_id, movie_wish_id,
    movie_title, movie_start_time, movie_duration_minutes,
    movie_genre, movie_watch_url, movie_description, movie_has_gore,
    movie_updated_at
  )
  select
    pma.date, pma.period_id, pmd.user_id, pmd.movie_wish_id,
    mw.movie_title, pmd.start_time, mw.movie_duration_minutes,
    mw.movie_genre, mw.movie_watch_url, mw.movie_description,
    coalesce(mw.movie_has_gore, false),
    case when mw.movie_title is not null then now() else null end
  from public.period_manual_assignments pma
  join public.period_movie_dates pmd on pmd.id = pma.movie_date_id
  join public.period_movie_wishes mw on mw.id = pmd.movie_wish_id
  where pma.period_id = p_period_id
    and pmd.submitted_at is not null
    and pmd.start_time is not null
    and public.is_activity_day(pma.date)
    and not exists (
      select 1 from public.activity_assignments a where a.date = pma.date
    );

  -- 反映済み(手動)の映画は二重当選させない。
  select coalesce(array_agg(movie_wish_id), array[]::uuid[])
    into v_scheduled
    from public.activity_assignments
    where period_id = p_period_id
      and movie_wish_id is not null;

  select coalesce(max(priority), 0) into v_max_priority
    from public.period_movie_dates
    where period_id = p_period_id
      and submitted_at is not null;

  for v_priority in 1..v_max_priority loop
    for v_date in
      select d::date
      from generate_series(v_first_day, v_last_day, interval '1 day') as d
      where public.is_activity_day(d::date)
        and not exists (
          select 1 from public.activity_assignments where date = d::date
        )
    loop
      -- この日・この優先順の候補。まだ当選していない映画のみ。
      -- 同じユーザー内では希望順が上(rank小)の映画を代表にし、他人とはランダム。
      select pmd.* into v_winner
      from public.period_movie_dates pmd
      join public.period_movie_wishes mw on mw.id = pmd.movie_wish_id
      where pmd.period_id = p_period_id
        and pmd.date = v_date
        and pmd.priority = v_priority
        and pmd.submitted_at is not null
        and pmd.start_time is not null
        and pmd.movie_wish_id <> all(v_scheduled)
        and not exists (
          select 1
          from public.period_movie_dates pmd2
          join public.period_movie_wishes mw2 on mw2.id = pmd2.movie_wish_id
          where pmd2.period_id = p_period_id
            and pmd2.date = v_date
            and pmd2.priority = v_priority
            and pmd2.submitted_at is not null
            and pmd2.start_time is not null
            and pmd2.user_id = pmd.user_id
            and pmd2.movie_wish_id <> all(v_scheduled)
            and mw2.rank < mw.rank
        )
      order by random()
      limit 1;

      if found then
        select * into v_wish
        from public.period_movie_wishes
        where id = v_winner.movie_wish_id;

        insert into public.activity_assignments (
          date, period_id, host_user_id, movie_wish_id,
          movie_title, movie_start_time, movie_duration_minutes,
          movie_genre, movie_watch_url, movie_description, movie_has_gore,
          movie_updated_at
        )
        values (
          v_date, p_period_id, v_winner.user_id, v_winner.movie_wish_id,
          v_wish.movie_title, v_winner.start_time, v_wish.movie_duration_minutes,
          v_wish.movie_genre, v_wish.movie_watch_url, v_wish.movie_description,
          coalesce(v_wish.movie_has_gore, false),
          case when v_wish.movie_title is not null then now() else null end
        );

        v_scheduled := array_append(v_scheduled, v_winner.movie_wish_id);
      end if;
    end loop;
  end loop;

  -- 上映確定した映画のうち、ウォッチリスト由来のものを消費済みにする。
  -- 物理削除せず、ロック解除で戻せるようにする。
  update public.movie_watchlist w
  set consumed_at = now(),
      consumed_period_id = p_period_id
  from public.activity_assignments a
  join public.period_movie_wishes mw on mw.id = a.movie_wish_id
  where a.period_id = p_period_id
    and a.movie_wish_id is not null
    and mw.source_watchlist_id = w.id
    and w.user_id = a.host_user_id
    and w.consumed_at is null;

  update public.activity_periods set locked_at = now() where id = p_period_id;
end;
$$;

revoke execute on function public._lock_activity_period(uuid, boolean) from public;
revoke execute on function public._lock_activity_period(uuid, boolean) from authenticated;

-- --------------------------------------------
-- (4)(6) unlock_activity_period: ウォッチリストの消費も巻き戻す
--   手動選択(予約)は集計時に消さなくなったので、そのまま残り再集計で復元される。
-- --------------------------------------------

create or replace function public.unlock_activity_period(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and is_admin
  ) then
    raise exception 'admin only';
  end if;

  -- 消費したウォッチリスト項目を戻す
  update public.movie_watchlist
  set consumed_at = null,
      consumed_period_id = null
  where consumed_period_id = p_period_id;

  delete from public.activity_assignments where period_id = p_period_id;
  update public.activity_periods set locked_at = null where id = p_period_id;
end;
$$;

grant execute on function public.unlock_activity_period(uuid) to authenticated;
