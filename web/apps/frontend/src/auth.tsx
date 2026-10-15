import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthResponse, Teacher } from '@classpulse/shared-types';
import { api, json, refreshAuth, setToken } from './api';
const AuthContext = createContext<{ teacher: Teacher | null; loading: boolean; login: (result: AuthResponse) => void; logout: () => Promise<void>; updateTeacher: (teacher: Teacher) => void } | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    refreshAuth().then(result => { if (active) { setTeacher(result?.teacher ?? null); setLoading(false); } });
    const expire = () => setTeacher(null);
    window.addEventListener('auth:expired', expire);
    return () => { active = false; window.removeEventListener('auth:expired', expire); };
  }, []);
  function login(result: AuthResponse) { setToken(result.accessToken); setTeacher(result.teacher); }
  async function logout() { await api('/auth/logout', json('POST')); setToken(null); setTeacher(null); }
  return <AuthContext.Provider value={{ teacher, loading, login, logout, updateTeacher: setTeacher }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('AuthProvider required'); return context; }
