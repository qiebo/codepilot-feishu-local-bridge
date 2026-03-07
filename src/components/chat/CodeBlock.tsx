'use client';

import { useState, useMemo, useRef } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Copy01Icon,
  Tick01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  SourceCodeIcon,
  CommandLineIcon,
  CodeIcon,
  File01Icon,
  HashtagIcon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';

const COLLAPSE_THRESHOLD = 20;
const VISIBLE_LINES = 10;

const TERMINAL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'terminal', 'zsh', 'console']);

function getLanguageIcon(language: string): IconSvgElement {
  const lower = language.toLowerCase();
  if (TERMINAL_LANGUAGES.has(lower)) return CommandLineIcon;
  if (['typescript', 'tsx', 'javascript', 'jsx'].includes(lower)) return CodeIcon;
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(lower)) return CodeIcon;
  if (['python', 'ruby', 'go', 'rust', 'java', 'c', 'cpp'].includes(lower)) return HashtagIcon;
  if (['css', 'scss', 'html'].includes(lower)) return File01Icon;
  return SourceCodeIcon;
}

interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
  maxCollapsedLines?: number;
}

export function CodeBlock({
  code,
  language = 'text',
  filename,
  showLineNumbers = true,
  maxCollapsedLines = VISIBLE_LINES,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const [animatingHeight, setAnimatingHeight] = useState<string | undefined>(undefined);

  const lines = useMemo(() => code.split('\n'), [code]);
  const totalLines = lines.length;
  const isCollapsible = totalLines > COLLAPSE_THRESHOLD;
  const isTerminal = TERMINAL_LANGUAGES.has(language.toLowerCase());

  const displayCode = useMemo(() => {
    if (!isCollapsible || expanded) return code;
    return lines.slice(0, maxCollapsedLines).join('\n');
  }, [code, lines, isCollapsible, expanded, maxCollapsedLines]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      const markdown = `\`\`\`${language}\n${code}\n\`\`\``;
      await navigator.clipboard.writeText(markdown);
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const handleToggleExpand = () => {
    const container = codeContainerRef.current;
    if (!container) {
      setExpanded(!expanded);
      return;
    }
    const currentHeight = container.scrollHeight;
    if (!expanded) {
      // Expanding: set current height, then switch to auto after transition
      setAnimatingHeight(`${currentHeight}px`);
      setExpanded(true);
      requestAnimationFrame(() => {
        // Measure the full height after content change
        const fullHeight = container.scrollHeight;
        setAnimatingHeight(`${fullHeight}px`);
        setTimeout(() => setAnimatingHeight(undefined), 300);
      });
    } else {
      // Collapsing: set current height, then reduce
      setAnimatingHeight(`${currentHeight}px`);
      requestAnimationFrame(() => {
        const collapsedH = maxCollapsedLines * 1.5 + 1.5;
        setAnimatingHeight(`${collapsedH}rem`);
        setTimeout(() => {
          setExpanded(false);
          setAnimatingHeight(undefined);
        }, 300);
      });
    }
  };

  const languageIconData = getLanguageIcon(language);

  const theme = isTerminal ? vscDarkPlus : oneDark;

  return (
    <div className="relative group not-prose my-3 rounded-lg overflow-hidden border border-zinc-700/50">
      {/* Header bar */}
      <div className={cn(
        "flex items-center justify-between px-4 py-1.5 text-xs",
        isTerminal
          ? "bg-zinc-950 text-zinc-400"
          : "bg-zinc-800 dark:bg-zinc-900 text-zinc-400"
      )}>
        <div className="flex items-center gap-2 min-w-0">
          <HugeiconsIcon icon={languageIconData} className={cn(
            "h-3.5 w-3.5 shrink-0",
            isTerminal ? "text-green-400" : "text-zinc-400",
          )} />
          {filename && (
            <span className="truncate text-zinc-300 font-medium">{filename}</span>
          )}
          {filename && <span className="text-zinc-600">|</span>}
          <span className={cn(
            "bg-zinc-700/50 rounded px-1.5 py-0.5",
            isTerminal && "text-green-400",
          )}>{language.toUpperCase()}</span>
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
            title="Copy code"
          >
            {copied ? (
              <>
                <HugeiconsIcon icon={Tick01Icon} className="h-3 w-3" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <HugeiconsIcon icon={Copy01Icon} className="h-3 w-3" />
                <span>Copy</span>
              </>
            )}
          </button>
          <button
            onClick={handleCopyMarkdown}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
            title="Copy as Markdown"
          >
            {copiedMarkdown ? (
              <>
                <HugeiconsIcon icon={Tick01Icon} className="h-3 w-3" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <HugeiconsIcon icon={SourceCodeIcon} className="h-3 w-3" />
                <span>Markdown</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code area */}
      <div
        ref={codeContainerRef}
        className="relative transition-[max-height] duration-300 ease-in-out overflow-hidden"
        style={{
          maxHeight: animatingHeight ?? (!isCollapsible || expanded ? undefined : `${maxCollapsedLines * 1.5 + 1.5}rem`),
        }}
      >
        <SyntaxHighlighter
          style={theme}
          language={language}
          PreTag="div"
          showLineNumbers={showLineNumbers && !isTerminal}
          lineNumberStyle={{
            minWidth: '2.5em',
            paddingRight: '1em',
            color: '#3a3a48',
            userSelect: 'none',
          }}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '0.8125rem',
            lineHeight: '1.5',
            padding: isTerminal ? '0.75rem 1rem' : '0.75rem 0.5rem',
            background: isTerminal ? '#0a0a0a' : undefined,
            overflow: 'auto',
          }}
          wrapLines
        >
          {expanded ? code : displayCode}
        </SyntaxHighlighter>

        {/* Gradient overlay for collapsed state */}
        {isCollapsible && !expanded && (
          <div className={cn(
            "absolute bottom-0 left-0 right-0 h-16 pointer-events-none",
            isTerminal
              ? "bg-gradient-to-t from-[#0a0a0a] to-transparent"
              : "bg-gradient-to-t from-[#282c34] to-transparent"
          )} />
        )}
      </div>

      {/* Expand/Collapse button */}
      {isCollapsible && (
        <button
          onClick={handleToggleExpand}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 py-1.5 text-xs transition-colors",
            isTerminal
              ? "bg-zinc-950 text-zinc-400 hover:text-zinc-200"
              : "bg-zinc-800 dark:bg-zinc-900 text-zinc-400 hover:text-zinc-200"
          )}
        >
          {expanded ? (
            <>
              <HugeiconsIcon icon={ArrowUp01Icon} className="h-3 w-3" />
              <span>Collapse</span>
            </>
          ) : (
            <>
              <HugeiconsIcon icon={ArrowDown01Icon} className="h-3 w-3" />
              <span>Expand all {totalLines} lines</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

// Inline code component for reuse
export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
      {children}
    </code>
  );
}
