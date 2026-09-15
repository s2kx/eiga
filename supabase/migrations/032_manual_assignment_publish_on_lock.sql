-- ============================================
-- 032_manual_assignment_publish_on_lock.sql
-- 管理者の手動選択を「即公表」から「集計（ロック）時に自動抽選と同時公表」へ変更する。
--
-- 031 では admin_assign_movie_date が activity_assignments（公開テーブル）へ
-- 直接書き込んでいたため、選んだ瞬間にメンバーへ公表されていた。
-- 本マイグレーションでは、管理者だけが見える予約テーブル period_manual_assignments に
-- 貯め、ロック時にまとめて反映する方式へ切り替える。
--
--  (1) period_manual_assignments テーブル（非公開・管理者のみ閲覧）を作成。
--  (2) 旧方式で未ロック期間に先行公開された手動割当を予約へ巻き戻す。
--  (3) admin_assign_movie_date / admin_clear_assignment を予約方式へ。
--  (4) _lock_activity_period をロック時に予約を反映する方式へ。
-- ============================================

-- (1) 管理者の手動選択（予約）。公表はロック時まで保留。
create table if not exists public.period_manual_assignments (
  period_id uuid not null references public.activity_periods(id) on delete cascade,
  date date not null,
  movie_date_id uuid not null references public.period_movie_dates(id) on delete cascade,
  movie_wish_id uuid not null references public.period_movie_wishes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (period_id, date)
);

create index if not exists period_manual_assignments_period_idx
  on public.period_manual_assignments(period_id);

alter table public.period_manual_assignments enable row level security;

-- 閲覧は管理者のみ（公開カレンダーには出さない）。書き込みは RPC 経由のみ。
drop policy if exists "period_manual_assignments_select_admin" on public.period_manual_assignments;
create policy "period_manual_assignments_select_admin" on public.period_manual_assignments
  for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin));

-- (2) 旧方式で「未ロック期間」に先行公開されていた手動割当を予約へ移す。
--     未ロック期間に movie_wish_id 付きの割当があれば、それは旧 admin_assign による
--     手動分（自動抽選はロック時にしか動かない）。対応する候補が見つかれば予約化する。
insert into public.period_manual_assignments (period_id, date, movie_date_id, movie_wish_id, user_id)
select a.period_id, a.date, pmd.id, a.movie_wish_id, a.host_user_id
from public.activity_assignments a
join public.activity_periods p on p.id = a.period_id
join public.period_movie_dates pmd
  on pmd.movie_wish_id = a.movie_wish_id and pmd.date = a.date
where p.locked_at is null
  and a.movie_wish_id is not null
on conflict (period_id, date) do nothing;

-- 未ロック期間の手動割当は公開テーブルから取り下げる（公表はロック時に行う）。
-- 予約へ移せたものだけを取り下げる。対応する候補日が既に消えていて予約化できなかった
-- 割当を消すと、その決定はどこにも残らず失われるため、公開テーブルに残して気づけるようにする。
delete from public.activity_assignments a
using public.activity_periods p
where p.id = a.period_id
  and p.locked_at is null
  and a.movie_wish_id is not null
  and exists (
    select 1 from public.period_manual_assignments pma
    where pma.period_id = a.period_id
      and pma.date = a.date
      and pma.movie_wish_id = a.movie_wish_id
  );

-- (3a) 候補日1件を「選択」する（予約）。締切前でも可、ロック後は不可。
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

  select * into v_period from public.activity_periods where id = v_pmd.period_id;
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

  -- 同じ映画を別の日に選択済みなら弾く（二重上映の防止）。
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

-- (3b) 手動選択の解除（ロック前のみ）。
create or replace function public.admin_clear_assignment(p_date date)
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

  select * into v_row from public.period_manual_assignments where date = p_date;
  if not found then
    return;
  end if;

  select * into v_period from public.activity_periods where id = v_row.period_id;
  if found and v_period.locked_at is not null then
    raise exception 'period is already locked';
  end if;

  delete from public.period_manual_assignments where date = p_date;
end;
$$;

grant execute on function public.admin_clear_assignment(date) to authenticated;

-- (4) _lock_activity_period:
--     - 手動選択(予約)を先に activity_assignments へ反映する（＝この瞬間に公表）。
--     - 反映済みの映画(movie_wish_id)は自動抽選の対象から除外する。
--     - 抽選で確定した割当にも movie_wish_id を記録する。
--     - ウォッチリストの消費はロックの最後にまとめて行う（手動/自動を統一）。
--     - 反映後、予約はクリアする。
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

  -- 上映確定した映画のうち、ウォッチリスト由来のものを本人のリストから削除する。
  delete from public.movie_watchlist w
  using public.activity_assignments a
  join public.period_movie_wishes mw on mw.id = a.movie_wish_id
  where a.period_id = p_period_id
    and a.movie_wish_id is not null
    and mw.source_watchlist_id = w.id
    and w.user_id = a.host_user_id;

  -- 反映済みの予約は片付ける。
  delete from public.period_manual_assignments where period_id = p_period_id;

  update public.activity_periods set locked_at = now() where id = p_period_id;
end;
$$;

revoke execute on function public._lock_activity_period(uuid, boolean) from public;
revoke execute on function public._lock_activity_period(uuid, boolean) from authenticated;
