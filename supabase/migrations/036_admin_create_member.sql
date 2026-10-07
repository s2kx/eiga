-- ============================================
-- 036_admin_create_member.sql
-- 管理者画面のアカウント作成を RPC 化する。
--
-- 035 で Supabase の「Allow new users to sign up」を無効にしたため、
-- 管理者画面の auth.signUp も "Signups not allowed for this instance" で
-- 失敗するようになった。サインアップは無効のまま（自己登録の封鎖を維持）、
-- 管理者だけが呼べる security definer 関数で auth.users / auth.identities /
-- profiles を1トランザクションで作る。
-- （admin_reset_password / admin_delete_member と同じく auth スキーマを直接扱う）
-- ============================================

create or replace function public.admin_create_member(
  p_username text,
  p_display_name text,
  p_password text,
  p_is_admin boolean default false,
  p_is_viewer boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_username text;
  v_display_name text;
  v_email text;
  v_user_id uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.profiles where id = v_caller and is_admin) then
    raise exception 'admin only';
  end if;

  v_username := trim(coalesce(p_username, ''));
  v_display_name := trim(coalesce(p_display_name, ''));

  if v_username !~ '^[A-Za-z0-9_]+$' then
    raise exception 'ユーザーIDは英数字とアンダースコアのみ使えます';
  end if;
  if v_display_name = '' then
    raise exception '表示名を入力してください';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'パスワードは6文字以上にしてください';
  end if;

  -- ログイン時は username を小文字化せずそのままメールにしているため、ここも同じ規則。
  v_email := v_username || '@circle.local';

  if exists (select 1 from public.profiles where username = v_username)
     or exists (select 1 from auth.users where lower(email) = lower(v_email)) then
    raise exception 'このユーザーIDは既に使われています';
  end if;

  v_user_id := gen_random_uuid();

  -- GoTrue はトークン系カラムが NULL だと読み込みに失敗するので空文字で埋める。
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now(),
    '', '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_user_id, v_user_id::text, 'email',
    jsonb_build_object(
      'sub', v_user_id::text,
      'email', v_email,
      'email_verified', true,
      'phone_verified', false
    ),
    now(), now(), now()
  );

  insert into public.profiles (id, username, display_name, is_admin, is_viewer)
  values (v_user_id, v_username, v_display_name, coalesce(p_is_admin, false), coalesce(p_is_viewer, false));

  return v_user_id;
end;
$$;

grant execute on function public.admin_create_member(text, text, text, boolean, boolean) to authenticated;
