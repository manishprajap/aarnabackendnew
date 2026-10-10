'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/config';

const LoginPage: React.FC = () => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError('Email and password are required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`${API_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.message || 'Login failed');
      }

      router.push('/admin');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-center text-xl font-bold text-gray-900">
          AI Project Ads
        </h1>

        <p className="mb-6 text-center text-sm text-gray-500">
          Admin Dashboard Login
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="mb-1 block text-xs font-semibold text-gray-600">
              Email
            </label>

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@ai-project-ads.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              autoComplete="username"
            />
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-xs font-semibold text-gray-600">
              Password
            </label>

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage; 