'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { WelcomeCard } from './WelcomeCard';
import { ClaudeCodeCard } from './ClaudeCodeCard';
import { ProviderCard } from './ProviderCard';
import { ProjectDirCard } from './ProjectDirCard';
import { useTranslation } from '@/hooks/useTranslation';
import type { SetupCardStatus } from '@/types';

interface SetupCenterProps {
  onClose: () => void;
  initialCard?: 'claude' | 'provider' | 'project';
}

export function SetupCenter({ onClose, initialCard }: SetupCenterProps) {
  const { t } = useTranslation();
  const [claudeStatus, setClaudeStatus] = useState<SetupCardStatus>('not-configured');
  const [providerStatus, setProviderStatus] = useState<SetupCardStatus>('not-configured');
  const [projectStatus, setProjectStatus] = useState<SetupCardStatus>('not-configured');
  const [defaultProject, setDefaultProject] = useState<string | undefined>();
  // Track the initial completedCount from the server so we only auto-close
  // when the user completes the last card during this session, not on reopen.
  const initialCompletedCountRef = useRef<number | null>(null);

  // Load initial status
  useEffect(() => {
    fetch('/api/setup')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setClaudeStatus(data.claude);
          setProviderStatus(data.provider);
          setProjectStatus(data.project);
          if (data.defaultProject) setDefaultProject(data.defaultProject);
          // Record how many were already done when we opened
          const initial = [data.claude, data.provider, data.project]
            .filter((s: string) => s === 'completed' || s === 'skipped').length;
          initialCompletedCountRef.current = initial;
        }
      })
      .catch(() => {});
  }, []);

  const completedCount = [claudeStatus, providerStatus, projectStatus]
    .filter(s => s === 'completed' || s === 'skipped').length;

  // Auto-close when all done — but only if user made progress during this session
  useEffect(() => {
    if (
      completedCount === 3 &&
      initialCompletedCountRef.current !== null &&
      initialCompletedCountRef.current < 3
    ) {
      // Mark as completed
      fetch('/api/setup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: 'completed', status: 'completed' }),
      }).catch(() => {});
      // Brief delay before closing
      const timer = setTimeout(onClose, 800);
      return () => clearTimeout(timer);
    }
  }, [completedCount, onClose]);

  // Scroll to initial card
  useEffect(() => {
    if (initialCard) {
      const el = document.getElementById(`setup-card-${initialCard}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [initialCard]);

  const handleProjectStatusChange = useCallback((status: SetupCardStatus, _value?: string) => {
    setProjectStatus(status);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border bg-card shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between bg-card px-6 pt-6 pb-3 border-b">
          <div>
            <h2 className="text-lg font-semibold">{t('setup.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('setup.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t('setup.progress', { completed: String(completedCount) })}
            </span>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => {
              // Persist skip so setup center doesn't reopen on next launch
              fetch('/api/setup', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card: 'completed', status: 'completed' }),
              }).catch(() => {});
              onClose();
            }}>
              {t('setup.skipAndEnter')}
            </Button>
          </div>
        </div>

        {/* Cards */}
        <div className="p-6 space-y-4">
          <WelcomeCard />

          <div id="setup-card-claude">
            <ClaudeCodeCard
              status={claudeStatus}
              onStatusChange={setClaudeStatus}
            />
          </div>

          <div id="setup-card-provider">
            <ProviderCard
              status={providerStatus}
              onStatusChange={setProviderStatus}
            />
          </div>

          <div id="setup-card-project">
            <ProjectDirCard
              status={projectStatus}
              onStatusChange={handleProjectStatusChange}
              defaultProject={defaultProject}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
