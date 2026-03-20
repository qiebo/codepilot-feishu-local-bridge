import type { CliToolDefinition } from '@/types';

export const CLI_TOOLS_CATALOG: CliToolDefinition[] = [
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    binNames: ['ffmpeg', 'ffprobe'],
    summaryZh: '音视频处理瑞士军刀，支持转码、剪辑、合并、流处理',
    summaryEn: 'Swiss army knife for audio/video — transcode, trim, merge, stream',
    categories: ['media'],
    installMethods: [
      { method: 'brew', command: 'brew install ffmpeg', platforms: ['darwin', 'linux'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'FFmpeg 是最强大的开源音视频处理工具，支持几乎所有格式的转码、剪辑、合并、滤镜处理和流媒体操作。Claude 可以帮你生成复杂的 FFmpeg 命令。',
      en: 'FFmpeg is the most powerful open-source audio/video processing tool. It supports transcoding, trimming, merging, filtering, and streaming for virtually all formats. Claude can help generate complex FFmpeg commands.',
    },
    useCases: {
      zh: ['视频格式转换（MP4/MKV/WebM 互转）', '音频提取和转码', '视频剪辑和拼接', '添加字幕和水印', '调整分辨率和码率'],
      en: ['Video format conversion (MP4/MKV/WebM)', 'Audio extraction and transcoding', 'Video trimming and concatenation', 'Add subtitles and watermarks', 'Adjust resolution and bitrate'],
    },
    guideSteps: {
      zh: ['安装 FFmpeg（推荐使用 Homebrew）', '安装完成后在终端输入 ffmpeg -version 验证', '在对话中描述你的音视频处理需求，Claude 会生成对应命令'],
      en: ['Install FFmpeg (Homebrew recommended)', 'Verify by running ffmpeg -version in terminal', 'Describe your audio/video task in chat — Claude will generate the command'],
    },
    examplePrompts: [
      { label: 'Convert to MP4', promptZh: '把 input.mov 转换成 MP4 格式，保持原始质量', promptEn: 'Convert input.mov to MP4 format, keeping original quality' },
      { label: 'Extract audio', promptZh: '从视频文件中提取音频并保存为 MP3', promptEn: 'Extract audio from a video file and save as MP3' },
      { label: 'Compress video', promptZh: '将视频压缩到 10MB 以内，尽量保持画质', promptEn: 'Compress video to under 10MB while maintaining quality' },
    ],
    homepage: 'https://ffmpeg.org',
    repoUrl: 'https://github.com/FFmpeg/FFmpeg',
    officialDocsUrl: 'https://ffmpeg.org/documentation.html',
    supportsAutoDescribe: true,
  },
  {
    id: 'jq',
    name: 'jq',
    binNames: ['jq'],
    summaryZh: '轻量级 JSON 处理器，支持查询、过滤、转换',
    summaryEn: 'Lightweight JSON processor — query, filter, transform',
    categories: ['data'],
    installMethods: [
      { method: 'brew', command: 'brew install jq', platforms: ['darwin', 'linux'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'jq 是命令行下的 JSON 处理利器，可以对 JSON 数据进行查询、过滤、映射和格式化。适合处理 API 响应、配置文件和日志分析。',
      en: 'jq is a powerful command-line JSON processor for querying, filtering, mapping, and formatting JSON data. Great for API responses, config files, and log analysis.',
    },
    useCases: {
      zh: ['解析和格式化 JSON 数据', '从 API 响应中提取特定字段', '批量转换 JSON 文件', '分析 JSON 格式的日志'],
      en: ['Parse and format JSON data', 'Extract specific fields from API responses', 'Batch transform JSON files', 'Analyze JSON-formatted logs'],
    },
    guideSteps: {
      zh: ['安装 jq', '运行 jq --version 验证安装', '使用管道将 JSON 数据传给 jq 处理'],
      en: ['Install jq', 'Verify with jq --version', 'Pipe JSON data to jq for processing'],
    },
    examplePrompts: [
      { label: 'Parse JSON', promptZh: '用 jq 从 package.json 中提取所有依赖名称', promptEn: 'Use jq to extract all dependency names from package.json' },
      { label: 'Filter array', promptZh: '用 jq 过滤 JSON 数组中 status 为 active 的项目', promptEn: 'Use jq to filter JSON array items where status is active' },
    ],
    homepage: 'https://jqlang.github.io/jq/',
    repoUrl: 'https://github.com/jqlang/jq',
    officialDocsUrl: 'https://jqlang.github.io/jq/manual/',
    supportsAutoDescribe: true,
  },
  {
    id: 'ripgrep',
    name: 'ripgrep',
    binNames: ['rg'],
    summaryZh: '极速文本搜索工具，比 grep 快数倍',
    summaryEn: 'Ultra-fast text search tool — orders of magnitude faster than grep',
    categories: ['search'],
    installMethods: [
      { method: 'brew', command: 'brew install ripgrep', platforms: ['darwin', 'linux'] },
      { method: 'cargo', command: 'cargo install ripgrep', platforms: ['darwin', 'linux', 'win32'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'ripgrep (rg) 是一个面向行的搜索工具，递归搜索当前目录中的正则表达式模式。它默认尊重 .gitignore 规则，速度极快。',
      en: 'ripgrep (rg) is a line-oriented search tool that recursively searches directories for regex patterns. It respects .gitignore rules by default and is extremely fast.',
    },
    useCases: {
      zh: ['在代码库中搜索特定模式', '查找包含特定文本的文件', '替代 grep 进行大规模搜索', '搜索时自动跳过 .gitignore 中的文件'],
      en: ['Search codebases for specific patterns', 'Find files containing specific text', 'Replace grep for large-scale searches', 'Auto-skip .gitignore files during search'],
    },
    guideSteps: {
      zh: ['安装 ripgrep', '运行 rg --version 验证安装', '使用 rg "pattern" 搜索当前目录'],
      en: ['Install ripgrep', 'Verify with rg --version', 'Use rg "pattern" to search current directory'],
    },
    examplePrompts: [
      { label: 'Search code', promptZh: '用 ripgrep 在项目中搜索所有 TODO 注释', promptEn: 'Use ripgrep to find all TODO comments in the project' },
      { label: 'Find usage', promptZh: '用 rg 搜索某个函数在哪些文件中被调用', promptEn: 'Use rg to find which files call a specific function' },
    ],
    homepage: 'https://github.com/BurntSushi/ripgrep',
    repoUrl: 'https://github.com/BurntSushi/ripgrep',
    supportsAutoDescribe: true,
  },
  {
    id: 'yt-dlp',
    name: 'yt-dlp',
    binNames: ['yt-dlp'],
    summaryZh: '功能强大的视频下载工具，支持数千个网站',
    summaryEn: 'Powerful video downloader supporting thousands of websites',
    categories: ['download', 'media'],
    installMethods: [
      { method: 'brew', command: 'brew install yt-dlp', platforms: ['darwin', 'linux'] },
      { method: 'pipx', command: 'pipx install yt-dlp', platforms: ['darwin', 'linux', 'win32'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'yt-dlp 是 youtube-dl 的活跃分支，支持从数千个网站下载视频和音频。功能包括格式选择、字幕下载、播放列表处理等。',
      en: 'yt-dlp is an actively maintained fork of youtube-dl, supporting video/audio downloads from thousands of websites. Features include format selection, subtitle download, playlist handling, and more.',
    },
    useCases: {
      zh: ['下载在线视频', '提取视频中的音频', '下载字幕文件', '批量下载播放列表'],
      en: ['Download online videos', 'Extract audio from videos', 'Download subtitles', 'Batch download playlists'],
    },
    guideSteps: {
      zh: ['安装 yt-dlp', '运行 yt-dlp --version 验证安装', '使用 yt-dlp URL 下载视频'],
      en: ['Install yt-dlp', 'Verify with yt-dlp --version', 'Use yt-dlp URL to download videos'],
    },
    examplePrompts: [
      { label: 'Download video', promptZh: '用 yt-dlp 下载这个视频的最高画质版本', promptEn: 'Use yt-dlp to download the highest quality version of this video' },
      { label: 'Extract audio', promptZh: '用 yt-dlp 只下载音频并转为 MP3', promptEn: 'Use yt-dlp to download audio only and convert to MP3' },
    ],
    homepage: 'https://github.com/yt-dlp/yt-dlp',
    repoUrl: 'https://github.com/yt-dlp/yt-dlp',
    officialDocsUrl: 'https://github.com/yt-dlp/yt-dlp#readme',
    supportsAutoDescribe: true,
  },
  {
    id: 'pandoc',
    name: 'Pandoc',
    binNames: ['pandoc'],
    summaryZh: '通用文档格式转换器，支持 Markdown/HTML/PDF/DOCX 等',
    summaryEn: 'Universal document converter — Markdown, HTML, PDF, DOCX, and more',
    categories: ['document'],
    installMethods: [
      { method: 'brew', command: 'brew install pandoc', platforms: ['darwin', 'linux'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'Pandoc 是一个通用的文档格式转换器，支持 Markdown、HTML、LaTeX、PDF、DOCX、EPUB 等数十种格式之间的相互转换。',
      en: 'Pandoc is a universal document converter supporting dozens of formats including Markdown, HTML, LaTeX, PDF, DOCX, EPUB, and more.',
    },
    useCases: {
      zh: ['Markdown 转 PDF/DOCX', 'HTML 转 Markdown', '批量文档格式转换', '生成电子书（EPUB）'],
      en: ['Markdown to PDF/DOCX', 'HTML to Markdown', 'Batch document conversion', 'Generate ebooks (EPUB)'],
    },
    guideSteps: {
      zh: ['安装 Pandoc', '运行 pandoc --version 验证安装', '使用 pandoc input.md -o output.pdf 转换文件'],
      en: ['Install Pandoc', 'Verify with pandoc --version', 'Use pandoc input.md -o output.pdf to convert files'],
    },
    examplePrompts: [
      { label: 'MD to PDF', promptZh: '用 pandoc 把 README.md 转成 PDF', promptEn: 'Use pandoc to convert README.md to PDF' },
      { label: 'HTML to MD', promptZh: '用 pandoc 把网页 HTML 转成 Markdown', promptEn: 'Use pandoc to convert HTML page to Markdown' },
    ],
    homepage: 'https://pandoc.org',
    repoUrl: 'https://github.com/jgm/pandoc',
    officialDocsUrl: 'https://pandoc.org/MANUAL.html',
    supportsAutoDescribe: true,
  },
  {
    id: 'imagemagick',
    name: 'ImageMagick',
    binNames: ['magick', 'convert'],
    summaryZh: '强大的图片处理工具，支持格式转换、缩放、裁剪、特效',
    summaryEn: 'Powerful image processing tool — convert, resize, crop, effects',
    categories: ['media'],
    installMethods: [
      { method: 'brew', command: 'brew install imagemagick', platforms: ['darwin', 'linux'] },
    ],
    setupType: 'simple',
    detailIntro: {
      zh: 'ImageMagick 是一个功能丰富的图片处理套件，支持 200+ 种图片格式的读写和转换，以及缩放、裁剪、旋转、合成、特效等操作。',
      en: 'ImageMagick is a feature-rich image processing suite supporting 200+ image formats for reading, writing, converting, resizing, cropping, compositing, and applying effects.',
    },
    useCases: {
      zh: ['批量图片格式转换', '图片缩放和裁剪', '添加水印和文字', '图片拼接和合成', 'PDF 转图片'],
      en: ['Batch image format conversion', 'Image resizing and cropping', 'Add watermarks and text', 'Image montage and compositing', 'PDF to image conversion'],
    },
    guideSteps: {
      zh: ['安装 ImageMagick', '运行 magick --version 验证安装', '使用 magick convert input.png output.jpg 转换图片'],
      en: ['Install ImageMagick', 'Verify with magick --version', 'Use magick convert input.png output.jpg to convert images'],
    },
    examplePrompts: [
      { label: 'Batch resize', promptZh: '用 ImageMagick 批量将文件夹中的图片缩放到 800px 宽', promptEn: 'Use ImageMagick to batch resize images in a folder to 800px wide' },
      { label: 'Add watermark', promptZh: '用 ImageMagick 给图片添加文字水印', promptEn: 'Use ImageMagick to add text watermark to images' },
    ],
    homepage: 'https://imagemagick.org',
    repoUrl: 'https://github.com/ImageMagick/ImageMagick',
    officialDocsUrl: 'https://imagemagick.org/script/command-line-processing.php',
    supportsAutoDescribe: true,
  },
  {
    id: 'gws',
    name: 'Google Workspace CLI',
    binNames: ['gws'],
    summaryZh: 'Google Workspace 命令行工具，支持 Drive/Gmail/Calendar/Sheets 等 API 操作',
    summaryEn: 'CLI for Google Workspace APIs — Drive, Gmail, Calendar, Sheets and more',
    categories: ['productivity'],
    installMethods: [
      { method: 'npm', command: 'npm install -g @googleworkspace/cli', platforms: ['darwin', 'linux', 'win32'] },
    ],
    setupType: 'needs_auth',
    detailIntro: {
      zh: 'gws 是 Google Workspace 的官方命令行工具，通过 Google Discovery Service 动态生成命令，自动覆盖所有 Workspace API。输出为结构化 JSON，天然适合 AI 代理和脚本集成。首次使用需通过 OAuth 完成身份认证。',
      en: 'gws is the official CLI for Google Workspace. It dynamically generates commands from Google Discovery Service, automatically covering all Workspace APIs. Output is structured JSON, making it ideal for AI agents and scripting. First-time use requires OAuth authentication.',
    },
    useCases: {
      zh: ['管理 Google Drive 文件（上传、下载、搜索）', '读取和发送 Gmail 邮件', '操作 Google Sheets 数据', '管理 Google Calendar 日程', '在 CI/脚本中自动化 Google Workspace 操作'],
      en: ['Manage Google Drive files (upload, download, search)', 'Read and send Gmail messages', 'Operate on Google Sheets data', 'Manage Google Calendar events', 'Automate Google Workspace operations in CI/scripts'],
    },
    guideSteps: {
      zh: ['安装 gws：npm install -g @googleworkspace/cli', '运行 gws auth setup 配置 Google Cloud 项目并登录', '运行 gws auth login 完成 OAuth 认证', '使用 gws drive files list 等命令操作 Workspace 资源'],
      en: ['Install gws: npm install -g @googleworkspace/cli', 'Run gws auth setup to configure Google Cloud project and log in', 'Run gws auth login to complete OAuth authentication', 'Use commands like gws drive files list to operate on Workspace resources'],
    },
    examplePrompts: [
      { label: 'List Drive files', promptZh: '用 gws 列出我 Google Drive 根目录下的文件', promptEn: 'Use gws to list files in my Google Drive root directory' },
      { label: 'Send email', promptZh: '用 gws 发送一封测试邮件', promptEn: 'Use gws to send a test email via Gmail' },
      { label: 'Read spreadsheet', promptZh: '用 gws 读取 Google Sheets 表格中的数据', promptEn: 'Use gws to read data from a Google Sheets spreadsheet' },
    ],
    homepage: 'https://github.com/googleworkspace/cli',
    repoUrl: 'https://github.com/googleworkspace/cli',
    officialDocsUrl: 'https://github.com/googleworkspace/cli#readme',
    supportsAutoDescribe: true,
  },
];

/**
 * Well-known CLI binaries to detect beyond the curated catalog.
 * These are probed at detection time to surface tools already on the system
 * that don't have a full catalog entry but are useful for AI workflows.
 * Each entry: [id, displayName, binName]
 */
export const EXTRA_WELL_KNOWN_BINS: Array<[string, string, string]> = [
  ['wget', 'wget', 'wget'],
  ['curl', 'curl', 'curl'],
  ['git', 'Git', 'git'],
  ['python3', 'Python 3', 'python3'],
  ['node', 'Node.js', 'node'],
  ['go', 'Go', 'go'],
  ['rustc', 'Rust', 'rustc'],
  ['docker', 'Docker', 'docker'],
  ['kubectl', 'kubectl', 'kubectl'],
  ['terraform', 'Terraform', 'terraform'],
  ['gh', 'GitHub CLI', 'gh'],
  ['aws', 'AWS CLI', 'aws'],
  ['gcloud', 'Google Cloud CLI', 'gcloud'],
  ['sox', 'SoX', 'sox'],
  ['sqlite3', 'SQLite', 'sqlite3'],
  ['htop', 'htop', 'htop'],
  ['tmux', 'tmux', 'tmux'],
  ['bat', 'bat', 'bat'],
  ['fd', 'fd', 'fd'],
  ['fzf', 'fzf', 'fzf'],
];
