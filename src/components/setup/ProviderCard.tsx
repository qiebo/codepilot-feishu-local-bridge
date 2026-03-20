'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { SetupCard } from './SetupCard';
import { useTranslation } from '@/hooks/useTranslation';
import type { SetupCardStatus, ApiProvider } from '@/types';

interface ProviderCardProps {
  status: SetupCardStatus;
  onStatusChange: (status: SetupCardStatus) => void;
}

export function ProviderCard({ status, onStatusChange }: ProviderCardProps) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [envDetected, setEnvDetected] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/providers');
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
        // Only count actual credential keys, not just ANTHROPIC_BASE_URL
        const credentialKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
        let hasEnv = data.env_detected && credentialKeys.some(k => k in data.env_detected);
        // Also check legacy app-settings token
        if (!hasEnv) {
          try {
            const settingsRes = await fetch('/api/settings/app');
            if (settingsRes.ok) {
              const settingsData = await settingsRes.json();
              const appToken = settingsData.settings?.anthropic_auth_token;
              if (appToken && !appToken.startsWith('***not')) hasEnv = true;
            }
          } catch { /* ignore */ }
        }
        setEnvDetected(hasEnv);
        if ((data.providers?.length ?? 0) > 0 || hasEnv) {
          onStatusChange('completed');
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [onStatusChange]);

  useEffect(() => {
    fetchProviders();

    const handler = () => fetchProviders();
    window.addEventListener('provider-changed', handler);
    return () => window.removeEventListener('provider-changed', handler);
  }, [fetchProviders]);

  const handleSkip = useCallback(async () => {
    onStatusChange('skipped');
    try {
      await fetch('/api/setup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: 'provider', status: 'skipped' }),
      });
    } catch { /* ignore */ }
  }, [onStatusChange]);

  const handleOpenProviders = useCallback(() => {
    // Navigate to settings providers section (SettingsLayout uses hash routing)
    window.location.href = '/settings#providers';
  }, []);

  const description = status === 'completed'
    ? t('setup.provider.configured')
    : t('setup.provider.description');

  return (
    <SetupCard
      title={t('setup.provider.title')}
      description={description}
      status={status}
      onSkip={status === 'not-configured' ? handleSkip : undefined}
    >
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : status === 'completed' ? (
        <p className="text-xs">
          {providers.length > 0
            ? `${providers.length} provider(s) configured`
            : envDetected
              ? 'Using Claude Code environment'
              : ''}
        </p>
      ) : (
        <div className="space-y-2">
          {envDetected ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('setup.provider.envDetected')}</p>
              <Button size="sm" className="text-xs" onClick={() => {
                onStatusChange('completed');
              }}>
                {t('setup.provider.useEnv')}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('setup.provider.noProvider')}</p>
              <Button size="sm" className="text-xs" onClick={handleOpenProviders}>
                {t('provider.addProvider')}
              </Button>
            </div>
          )}
        </div>
      )}
    </SetupCard>
  );
}
