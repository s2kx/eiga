import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Profile = {
  id: string
  username: string
  display_name: string
  is_admin: boolean
  is_viewer: boolean
}

type AuthContextType = {
  user: User | null
  profile: Profile | null
  loading: boolean
  signIn: (username: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  // 取得済みプロフィールのユーザーID。同一ユーザーの再取得を避ける。
  const profileUserIdRef = useRef<string | null>(null)

  const fetchProfile = async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    setProfile(data)
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      profileUserIdRef.current = u?.id ?? null
      // プロフィールを取り終えるまで loading を落とさない。
      // 先に落とすと ProtectedRoute が profile=null のまま権限判定してしまい、
      // /admin や /applications をリロードしただけで弾かれる。
      if (u) {
        await fetchProfile(u.id)
      }
      setLoading(false)
    })

    // タブ再フォーカス時などに Supabase が再発火する。
    // 同じユーザーなら user の参照を維持し、不要な再取得・再描画を防ぐ。
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null
      setUser((prev) => (prev?.id === nextUser?.id ? prev : nextUser))

      if (!nextUser) {
        profileUserIdRef.current = null
        setProfile(null)
        return
      }
      // 実際にユーザーが変わったときだけプロフィールを取り直す。
      // 取得中は loading を立てて、権限判定が profile=null で走らないようにする。
      if (profileUserIdRef.current !== nextUser.id) {
        profileUserIdRef.current = nextUser.id
        setLoading(true)
        void fetchProfile(nextUser.id).finally(() => setLoading(false))
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (username: string, password: string) => {
    const email = `${username}@circle.local`
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      return { error: 'ユーザーIDまたはパスワードが正しくありません' }
    }
    return { error: null }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setProfile(null)
  }

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signIn, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
