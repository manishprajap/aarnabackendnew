'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL } from '@/lib/config';
import styles from './page.module.css';

const LoginPage: React.FC = () => {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError('Enter your email address and password to continue.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Unable to sign in. Check your details and try again.');
      }

      router.push('/admin');
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <section className={styles.visualPanel} aria-label="Aarnex AI">
        <div className={styles.visualGlow} />
        <div className={styles.visualContent}>
          <div className={styles.brandCard}>
            <img className={styles.logo} src="/aarnexai-backend/aarna-logo.png" alt="Aarnex AI" />
          </div>
          <div className={styles.visualCopy}>
            <span className={styles.eyebrow}>ADMIN WORKSPACE</span>
            <h1>Make every<br />campaign count.</h1>
            <p>Manage your marketing platform from one secure, beautifully simple workspace.</p>
          </div>
          <div className={styles.visualFooter}>
            <span className={styles.statusDot} />
            Secure workspace access
          </div>
        </div>
        <div className={styles.decorativeOrb} aria-hidden="true" />
        <div className={styles.decorativeGrid} aria-hidden="true" />
      </section>

      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <div className={styles.mobileBrand}>
            <img className={styles.mobileLogo} src="/aarnexai-backend/aarna-logo.png" alt="Aarnex AI" />
            <span>ADMIN CONSOLE</span>
          </div>

          <div className={styles.formHeading}>
            <span className={styles.formEyebrow}>WELCOME BACK</span>
            <h2>Sign in to your account</h2>
            <p>Enter your administrator credentials to continue.</p>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.field}>
              <span>Email address</span>
              <div className={styles.inputWrap}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
                  <path d="m4.5 7 7.5 6 7.5-6" />
                </svg>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="username"
                  autoCapitalize="none"
                  required
                />
              </div>
            </label>

            <label className={styles.field}>
              <span>Password</span>
              <div className={styles.inputWrap}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="4.5" y="10" width="15" height="11" rx="2.5" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
                </svg>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                />
                <button
                  className={styles.passwordToggle}
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>

            {error && <p className={styles.error} role="alert">{error}</p>}

            <button className={styles.submit} type="submit" disabled={loading}>
              {loading ? (
                <>
                  <span className={styles.spinner} aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in securely
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <div className={styles.securityNote}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3 19 6v5c0 4.6-2.9 8-7 10-4.1-2-7-5.4-7-10V6l7-3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span>Your session is protected with secure authentication.</span>
          </div>

          <footer className={styles.formFooter}>© {new Date().getFullYear()} Aarnex AI · Admin Console</footer>
        </div>
      </section>
    </main>
  );
};

export default LoginPage;
