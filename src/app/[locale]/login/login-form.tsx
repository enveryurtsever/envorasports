'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { login, type LoginState } from '@/lib/auth/actions';

export function LoginForm() {
  const t = useTranslations('auth');
  const router = useRouter();

  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    async (prev, formData) => {
      const result = await login(prev, formData);
      // The session cookie is set by the action; refresh so the server
      // components re-render with the new viewer.
      if (!result.error) router.replace('/account');
      return result;
    },
    { error: null },
  );

  return (
    <form action={formAction} className="mt-5 space-y-3">
      <label className="block">
        <span className="text-xs text-muted uppercase">{t('email')}</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs text-muted uppercase">{t('password')}</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-rose-300">
          {t('invalidCredentials')}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? t('signingIn') : t('signIn')}
      </button>
    </form>
  );
}
