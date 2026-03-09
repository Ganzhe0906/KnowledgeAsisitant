"use client";

import { useState, useRef, useEffect } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Loader2, CheckCircle2, AlertCircle, Sparkles, Terminal } from "lucide-react";

const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs));

// URL 提取正则，用于从大段文本中匹配出 http/https 链接
const EXTRACT_URL_REGEX = /(https?:\/\/[^\s]+)/;

type ProcessStatus =
  | "idle"
  | "parsing"
  | "purifying"
  | "syncing"
  | "done"
  | "error";

interface ProcessResult {
  title: string;
  tag: string;
  content: string;
  folder?: string;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [isDirectMode, setIsDirectMode] = useState(false);
  const [status, setStatus] = useState<ProcessStatus>("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLogs([]);
    setStepIndex(0);

    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("请输入内容");
      return;
    }

    // 从混杂文本中提取 URL
    const urlMatch = trimmedUrl.match(EXTRACT_URL_REGEX);
    if (!urlMatch || !urlMatch[0]) {
      setError("未识别到有效的链接，请检查后重试");
      return;
    }

    const actualUrl = urlMatch[0];

    setStatus("parsing");
    setStepIndex(1);

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: actualUrl, isDirectMode }),
      });

      if (!res.body) throw new Error("服务器未返回数据流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        buffer = lines.pop() || ""; // 最后一行可能是不完整的，留到下一次处理

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (!dataStr) continue;
            
            try {
              const data = JSON.parse(dataStr);
              
              if (data.message) {
                setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${data.message}`]);
              }

              if (data.step === 'parsing_done') {
                setStatus('purifying');
                setStepIndex(2);
              } else if (data.step === 'purifying') {
                setStatus('purifying');
                setStepIndex(2);
              } else if (data.step === 'purifying_done') {
                setStatus('syncing');
                setStepIndex(3);
              } else if (data.step === 'syncing') {
                setStatus('syncing');
                setStepIndex(3);
              } else if (data.step === 'done') {
                setStatus("done");
                setStepIndex(4);
                if (data.result) {
                  setResult(data.result);
                }
              } else if (data.step === 'error') {
                setStatus("error");
                setError(data.message || "处理过程中发生错误");
              }
            } catch (err) {
              console.error("解析流数据失败:", err, dataStr);
            }
          }
        }
      }

    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "网络错误，请重试");
    }
  };

  const statusSteps = [
    { key: "idle", label: "等待输入", icon: null },
    { key: "parsing", label: "解析音视频", icon: Loader2 },
    { key: "purifying", label: "AI 提纯中", icon: Loader2 },
    { key: "syncing", label: "同步 Obsidian", icon: Loader2 },
    { key: "done", label: "完成", icon: CheckCircle2 },
  ] as const;

  const currentStepIndex = stepIndex;
  const isProcessing =
    status === "parsing" || status === "purifying" || status === "syncing";

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans antialiased">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <header className="text-center mb-12">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            多模态知识采集
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            输入音视频链接，AI 提纯后同步至 Obsidian
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="支持直接粘贴 B站/抖音 的分享文案或链接"
              disabled={isProcessing}
              className={cn(
                "w-full h-14 px-5 rounded-xl",
                "bg-zinc-900/80 border border-zinc-700/60",
                "text-white placeholder:text-zinc-500",
                "focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500",
                "transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              )}
            />
          </div>

          {/* 模式切换开关 */}
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-300">直通总结模式</span>
              <span className="text-xs text-zinc-500">
                {isDirectMode ? "无视字数，直接使用内置总结" : "字数 > 500 时使用 Gemini 提纯"}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isDirectMode}
              onClick={() => setIsDirectMode(!isDirectMode)}
              disabled={isProcessing}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[#0a0a0a] disabled:opacity-50 disabled:cursor-not-allowed",
                isDirectMode ? "bg-blue-500" : "bg-zinc-700"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out",
                  isDirectMode ? "translate-x-5" : "translate-x-0"
                )}
              />
            </button>
          </div>

          <button
            type="submit"
            disabled={isProcessing}
            className={cn(
              "w-full h-12 rounded-xl font-medium",
              "bg-white text-black hover:bg-zinc-200",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center justify-center gap-2 transition-all"
            )}
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                处理中...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                开始提纯
              </>
            )}
          </button>
        </form>

        {/* 状态指示器 */}
        <div className="mt-12 mb-8 px-2">
          <div className="relative flex justify-between">
            {/* 连线层 */}
            <div className="absolute top-4 left-4 right-4 h-0.5 bg-zinc-800" />
            <div 
              className="absolute top-4 left-4 right-4 h-0.5" 
            >
              <div 
                className="h-full bg-blue-500 transition-all duration-500" 
                style={{ 
                  width: `${currentStepIndex >= 0 ? (currentStepIndex / (statusSteps.length - 1)) * 100 : 0}%` 
                }}
              />
            </div>
            
            {/* 步骤图标和文字 */}
            {statusSteps.map((step, idx) => {
              const StepIcon = step.icon;
              const isActive = idx <= currentStepIndex;
              const isCurrent = step.key === status;
              const showError = status === "error" && idx === currentStepIndex;

              return (
                <div key={step.key} className="relative z-10 flex flex-col items-center gap-3">
                  <div
                    className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors duration-300",
                      showError
                        ? "bg-red-500 text-white"
                        : isActive
                          ? "bg-blue-500 text-white"
                          : "bg-zinc-800 text-zinc-500"
                    )}
                  >
                    {showError ? (
                      <AlertCircle className="w-4 h-4" />
                    ) : StepIcon && isCurrent && step.key !== "done" ? (
                      <StepIcon className="w-4 h-4 animate-spin" />
                    ) : StepIcon && isActive ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      idx + 1
                    )}
                  </div>
                  <span 
                    className={cn(
                      "text-[10px] sm:text-xs font-medium transition-colors duration-300",
                      isActive || showError ? "text-zinc-200" : "text-zinc-500"
                    )}
                  >
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 错误展示 */}
        {error && (
          <div
            className={cn(
              "mt-8 p-4 rounded-xl",
              "bg-red-500/10 border border-red-500/30",
              "flex items-center gap-3 text-red-400"
            )}
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* 实时日志终端展示 */}
        {logs.length > 0 && (
          <div className="mt-8 rounded-xl border border-zinc-700/60 bg-[#0c0c0c] overflow-hidden animate-in fade-in slide-in-from-top-4 duration-500">
            <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between bg-[#1a1a1a]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-zinc-400" />
                <span className="text-xs font-medium text-zinc-400">处理日志 (Real-time logs)</span>
              </div>
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-zinc-700"></div>
              </div>
            </div>
            <div className="p-4 h-48 overflow-y-auto font-mono text-xs text-zinc-300 space-y-2">
              {logs.map((log, i) => {
                const isError = log.includes('错误') || log.includes('失败');
                const isSuccess = log.includes('成功') || log.includes('完成');
                const timeStr = log.match(/\[(.*?)\]/)?.[0] || '';
                const msgStr = log.replace(timeStr, '').trim();
                
                return (
                  <div key={i} className="flex gap-2 leading-relaxed">
                    <span className="text-zinc-600 shrink-0 select-none">&gt;</span>
                    {timeStr && <span className="text-zinc-500 shrink-0">{timeStr}</span>}
                    <span className={isError ? 'text-red-400' : isSuccess ? 'text-green-400' : 'text-zinc-300'}>
                      {msgStr}
                    </span>
                  </div>
                );
              })}
              {isProcessing && (
                <div className="flex gap-2 leading-relaxed text-zinc-500 animate-pulse">
                  <span className="text-zinc-600 shrink-0 select-none">&gt;</span>
                  <span>等待响应...</span>
                </div>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}

        {/* 结果预览卡片 */}
        {result && (
          <div className="mt-8 rounded-xl border border-zinc-700/60 bg-zinc-900/50 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="px-5 py-4 border-b border-zinc-700/60 bg-zinc-900/80">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-medium text-zinc-300">提纯结果</h2>
                <div className="flex gap-2">
                  {result.tag && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-500/20 text-blue-300 text-[10px] font-medium uppercase tracking-wider">
                      #{result.tag}
                    </span>
                  )}
                  {result.folder && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-400 text-[10px] font-medium tracking-wider">
                      📁 {result.folder}
                    </span>
                  )}
                </div>
              </div>
              <h3 className="text-lg font-semibold text-white mt-1 leading-tight">
                {result.title}
              </h3>
            </div>
            <div className="p-5">
              <div className="prose prose-invert prose-sm max-w-none">
                <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed bg-transparent p-0 border-0">
                  {result.content}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
