import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Alert } from '../antdImports';
import { useAuth } from '../hooks/useAuth';
import { LanguageSwitcher } from './LanguageSwitcher';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const { t } = useTranslation();
  const { loading, error, login, changePassword, clearError } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeLoading, setChangeLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await login(username, password);
    if (result.success) {
      if (result.passwordChangeRequired) {
        setShowChangePassword(true);
      } else {
        onLoginSuccess();
      }
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangeError(null);

    if (newPassword.length < 6) {
      setChangeError(t('login.validation.passwordLength'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError(t('login.validation.passwordMismatch'));
      return;
    }
    if (newPassword === password) {
      setChangeError(t('login.validation.passwordSameAsOld'));
      return;
    }

    setChangeLoading(true);
    const success = await changePassword(password, newPassword);
    setChangeLoading(false);

    if (success) {
      setShowChangePassword(false);
      onLoginSuccess();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-[384px]">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-9 h-9 rounded bg-accent-teal flex items-center justify-center text-bg-primary text-sm font-bold">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="7" width="4" height="6" rx="1" fill="currentColor" opacity="0.9" />
              <rect x="5" y="4" width="4" height="9" rx="1" fill="currentColor" />
              <rect x="9" y="1" width="4" height="12" rx="1" fill="currentColor" opacity="0.9" />
            </svg>
          </div>
          <span className="text-lg font-semibold text-text-primary">LLM API Bench</span>
        </div>

        {/* Login Card */}
        <div className="bg-bg-surface border border-border rounded-lg p-6 pb-4">
          {showChangePassword ? (
            <>
              <h2 className="text-text-primary text-base font-medium mb-2">{t('login.changePassword')}</h2>
              <p className="text-text-secondary text-xs mb-4">{t('login.changePasswordDesc')}</p>

              {changeError && (
                <Alert
                  title={changeError}
                  type="error"
                  showIcon
                  closable
                  onClose={() => setChangeError(null)}
                  style={{ marginBottom: 16 }}
                />
              )}

              <form onSubmit={handleChangePassword}>
                <div className="mb-4">
                  <label htmlFor="new-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.newPassword')}
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('login.atLeast6Chars')}
                    autoFocus
                    className="w-full h-10 px-3 rounded-md border border-border bg-bg-primary text-text-primary text-sm outline-none focus:border-accent-teal transition-colors"
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="confirm-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.confirmPassword')}
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('login.reEnterPassword')}
                    className="w-full h-10 px-3 rounded-md border border-border bg-bg-primary text-text-primary text-sm outline-none focus:border-accent-teal transition-colors"
                  />
                </div>
                <Button type="primary" htmlType="submit" loading={changeLoading} block size="large">
                  {t('login.changePassword')}
                </Button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-text-primary text-base font-medium mb-4">{t('login.signIn')}</h2>

              {error && (
                <Alert title={error} type="error" showIcon closable onClose={clearError} style={{ marginBottom: 16 }} />
              )}

              <form onSubmit={handleSubmit}>
                <div className="mb-4">
                  <label htmlFor="login-username" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.username')}
                  </label>
                  <input
                    id="login-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('login.usernamePlaceholder')}
                    autoFocus
                    className="w-full h-10 px-3 rounded-md border border-border bg-bg-primary text-text-primary text-sm outline-none focus:border-accent-teal transition-colors"
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="login-password" className="block text-text-secondary text-xs mb-1.5">
                    {t('login.password')}
                  </label>
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('login.enterPassword')}
                    className="w-full h-10 px-3 rounded-md border border-border bg-bg-primary text-text-primary text-sm outline-none focus:border-accent-teal transition-colors"
                  />
                </div>
                <Button type="primary" htmlType="submit" loading={loading} block size="large" style={{ marginTop: 8 }}>
                  {t('login.signIn')}
                </Button>
              </form>
            </>
          )}
          {/* Language switcher */}
          <div className="flex justify-center mt-4 pt-3 border-t border-border">
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </div>
  );
}
