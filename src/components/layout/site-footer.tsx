import { getTranslations } from 'next-intl/server';

export async function SiteFooter() {
  const t = await getTranslations('footer');
  const brand = await getTranslations('brand');
  const disclaimer = await getTranslations('disclaimer');

  return (
    <footer className="mt-auto border-t border-white/10 bg-ink/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 pb-24 sm:px-6 md:pb-8">
        {/* §29 requires this to be visible, not buried in a legal page. */}
        <p className="max-w-3xl text-sm leading-relaxed text-muted">{disclaimer('long')}</p>
        <p className="mt-4 text-xs text-muted-dark">
          © {new Date().getFullYear()} {brand('name')}. {t('rights')}
        </p>
      </div>
    </footer>
  );
}
