'use client';

import { Button } from '@/components/ui/button';
import { FolderOpen } from '@/components/ui/icon';
import { useTranslation } from '@/hooks/useTranslation';

interface ChatEmptyStateProps {
  hasDirectory: boolean;
  hasProvider: boolean;
  onSelectFolder: () => void;
  recentProjects?: string[];
  onSelectProject?: (path: string) => void;
}

export function ChatEmptyState({
  hasDirectory,
  hasProvider,
  onSelectFolder,
  recentProjects,
  onSelectProject,
}: ChatEmptyStateProps) {
  const { t } = useTranslation();

  if (hasDirectory && hasProvider) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">{t('chat.empty.ready')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm space-y-4 text-center">
        {!hasDirectory && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('chat.empty.noDirectory')}</p>
            <div className="flex flex-col items-center gap-2">
              <Button size="sm" className="gap-1.5" onClick={onSelectFolder}>
                <FolderOpen size={14} />
                {t('chat.empty.selectFolder')}
              </Button>
              {recentProjects && recentProjects.length > 0 && onSelectProject && (
                <div className="space-y-1.5 mt-2">
                  <p className="text-xs text-muted-foreground">{t('chat.empty.recentProjects')}</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {recentProjects.slice(0, 5).map(p => {
                      const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
                      return (
                        <Button
                          key={p}
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[11px] font-mono"
                          onClick={() => onSelectProject(p)}
                          title={p}
                        >
                          {name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!hasProvider && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('chat.empty.noProvider')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.dispatchEvent(new CustomEvent('open-setup-center', { detail: { initialCard: 'provider' } }))}
            >
              {t('chat.empty.openSetup')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
