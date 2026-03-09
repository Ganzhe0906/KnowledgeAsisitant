import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

// ============ 类型定义 ============

interface ProcessRequestPayload {
  url: string;
  isDirectMode?: boolean;
}

interface ProcessResponse {
  tag: string;
  content: string;
  folder?: string;
  title?: string;
}

// URL 校验正则
const URL_REGEX =
  /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)$/;

// ============ 主逻辑 ============

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (data: Record<string, unknown>) => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch (e) {
      console.error("Stream write error:", e);
    }
  };

  const closeStream = async () => {
    try {
      await writer.close();
    } catch (e) {
      console.error("Stream close error:", e);
    }
  };

  (async () => {
    try {
      const body = await request.json();
      const { url, isDirectMode = false } = body as ProcessRequestPayload;

      if (!url || typeof url !== "string") {
        await sendEvent({ step: "error", message: "缺少 url 参数" });
        await closeStream();
        return;
      }

      const trimmedUrl = url.trim();
      if (!URL_REGEX.test(trimmedUrl)) {
        await sendEvent({ step: "error", message: "URL 格式不正确" });
        await closeStream();
        return;
      }

      const BIBIGPT_KEY = process.env.BIBIGPT_API_KEY;
      const GEMINI_KEY = process.env.GEMINI_API_KEY;

      if (!BIBIGPT_KEY || !GEMINI_KEY) {
        const missing = [];
        if (!BIBIGPT_KEY) missing.push("BIBIGPT_API_KEY");
        if (!GEMINI_KEY) missing.push("GEMINI_API_KEY");
        await sendEvent({ step: "error", message: `未配置 API Key: ${missing.join(", ")}。` });
        await closeStream();
        return;
      }

      let result: ProcessResponse;
      let rawTranscript = "";
      let finalContent = "";

      try {
        // ==========================================
        // Step 1: 尝试极速获取纯字幕 (Tier 1)
        // ==========================================
        await sendEvent({ step: "parsing", message: "开始尝试极速获取音视频字幕..." });
        console.log(`[BibiGPT] 尝试极速获取字幕: ${trimmedUrl}`);
        try {
          const subRes = await axios.get(
            `https://api.bibigpt.co/api/v1/getSubtitle?url=${encodeURIComponent(trimmedUrl)}`,
            {
              headers: { Authorization: `Bearer ${BIBIGPT_KEY}` },
              timeout: 30000, 
            }
          );

          let subtitlesArray: { text?: string; content?: string }[] = [];
          const possiblePaths = [
            subRes.data?.detail,
            subRes.data?.subtitles,
            subRes.data?.data?.detail,
            subRes.data?.data?.subtitles,
            subRes.data?.data?.data,
            subRes.data?.data,
          ];

          for (const path of possiblePaths) {
            if (Array.isArray(path) && path.length > 0) {
              subtitlesArray = path;
              break;
            }
          }

          if (subtitlesArray.length > 0) {
            rawTranscript = subtitlesArray
              .map((item: { text?: string; content?: string }) => item.text || item.content || "")
              .join(" ")
              .trim();
          } else if (typeof subRes.data === "string") {
            rawTranscript = subRes.data.trim();
          }
        } catch (subErr) {
          console.warn("[BibiGPT 获取字幕失败，将直接进入降级总结]:", subErr instanceof Error ? subErr.message : "未知错误");
          await sendEvent({ message: "获取字幕出现问题，将尝试直接总结" });
        }

        await sendEvent({ step: "parsing_done", message: `字幕获取完毕，字数: ${rawTranscript.length}` });
        await sendEvent({ step: "purifying", message: "开始 AI 提纯阶段..." });

        // ==========================================
        // Step 2: 智能路由分发 (根据字数判断)
        // ==========================================
        if (isDirectMode || rawTranscript.length < 500) {
          // --- 路由 A: 字数过少或无字幕，走 BibiGPT 直出 ---
          if (isDirectMode) {
            await sendEvent({ message: "用户开启直通模式，触发内置总结..." });
          } else {
            await sendEvent({ message: "字数较少或无字幕，触发视觉总结直通车..." });
          }
          
          let bibiSummary = "";

          try {
            const summaryRes = await axios.get(
              `https://api.bibigpt.co/api/v1/summarize?url=${encodeURIComponent(trimmedUrl)}&isRefresh=true`,
              {
                headers: {
                  Authorization: `Bearer ${BIBIGPT_KEY}`,
                },
                timeout: 60000, 
              }
            );

            const summaryData = summaryRes.data;
            bibiSummary = typeof summaryData?.summary === "string" 
              ? summaryData.summary 
              : (summaryData?.summary?.content || "");

            if (!bibiSummary) {
               throw new Error("返回结果为空");
            }
          } catch (fallbackErr) {
            console.warn("[BibiGPT 视觉总结彻底失败，已被兜底拦截]:", fallbackErr);
            bibiSummary = "⚠️ **解析被拦截或无内容**：该视频缺乏可提取的文本，且平台的反爬虫机制屏蔽了标题与描述的获取。对于此类极端的纯视觉素材，建议直接点击原链接查看动作演示。";
          }

          finalContent = `> ⚡ **${isDirectMode ? "直通模式使用内置总结" : "字数不足500，触发视觉素材直通车"}**\n\n${bibiSummary}\n\n---\n**原始链接**：${trimmedUrl}\n**处理时间**：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;

        } else {
          // --- 路由 B: 字数充足，走 Gemini 提纯 ---
          await sendEvent({ message: "字数充足，送入 Gemini 进行深度提纯..." });
          
          const prompt = `
你是一个资深的知识整理专家与内容操盘手。请根据以下音视频转录内容，提炼出一份高质量、结构化的 Markdown 笔记。
要求：
1. 语言简洁、专业，去除废话。
2. 包含核心观点、关键细节和可复用的执行建议。
3. 使用清晰的二级标题梳理内容脉络。
4. 在笔记末尾添加原始链接和提纯时间。

转录内容如下：
${rawTranscript}

原始链接：${trimmedUrl}
`;

          const geminiRes = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_KEY}`,
            {
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 8192,
              },
            },
            {
              headers: { "Content-Type": "application/json" },
              timeout: 45000,
            }
          );

          finalContent = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!finalContent) {
            throw new Error("Gemini 提纯失败，未返回有效内容。");
          }
        }

        await sendEvent({ step: "purifying_done", message: "AI 提纯完毕！" });

        // ==========================================
        // Step 2.5: 智能生成标题
        // ==========================================
        await sendEvent({ step: "titling", message: "正在为笔记生成 AI 标题..." });
        
        let aiTitle = `未命名视频笔记_${new Date().getTime()}`;
        try {
          const titlePrompt = `你现在的任务是为一段视频或文章的摘要起一个标题。这个标题将作为笔记的文件名。

【必须严格遵守的规则】
1. 标题长度必须在 8 到 20 个字之间！绝对禁止输出 5 个字以下的极短标题！
2. 标题必须是一个完整的短语或句子，能够清晰描述事件、知识点或主题。
3. 直接输出标题，不要任何多余的字、标点符号、引号或解释。
4. 不要包含特殊符号（如 / \\ : * ? " < > |）。

【好标题示例】
- 苹果发布M4芯片：AI性能大幅提升
- 普通人如何通过三个习惯改善睡眠
- 2024年独立开发者的变现指南

【坏标题示例】（绝对禁止这样输出）
- 苹果
- 睡眠
- 总结
- 观后感

请根据以下内容，生成标题：
---
${finalContent.substring(0, 2000)}`;
          
          const titleRes = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_KEY}`,
            {
              contents: [{ parts: [{ text: titlePrompt }] }],
              generationConfig: {
                temperature: 0.5,
                maxOutputTokens: 1000,
              },
            },
            {
              headers: { "Content-Type": "application/json" },
              timeout: 10000,
            }
          );
          
          const generatedText = titleRes.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (generatedText) {
             const cleanTitle = generatedText.replace(/[\/\\:\*\?"<>\|\n\r]/g, '').trim();
             if (cleanTitle) {
               aiTitle = cleanTitle;
             }
          }
        } catch (titleErr) {
          console.warn("[生成标题失败]:", titleErr instanceof Error ? titleErr.message : "未知错误");
        }

        await sendEvent({ step: "syncing", message: "准备同步到 Obsidian..." });

        // ==========================================
        // Step 3: 构造最终结果
        // ==========================================
        result = {
          tag: "知识",
          title: aiTitle,
          content: finalContent,
          folder: "knowledge",
        };

      } catch (apiErr: unknown) {
        let errMsg = "请求 AI 服务时出错";
        if (axios.isAxiosError(apiErr)) {
          errMsg = apiErr.response?.data?.error?.message || apiErr.message || errMsg;
        } else if (apiErr instanceof Error) {
          errMsg = apiErr.message;
        }
        await sendEvent({ step: "error", message: `处理失败: ${errMsg}` });
        await closeStream();
        return;
      }

      // ---------- Bridge 推送 ----------
      const bridgeUrl = process.env.OBSIDIAN_BRIDGE_URL?.trim();
      const bridgeApiKey = process.env.OBSIDIAN_API_KEY?.trim() || 'ai-diary-mcp-key';

      if (bridgeUrl) {
        try {
          await sendEvent({ message: `正在全自动化推送至 Obsidian (${result.folder} 目录)...` });
          await axios.post(bridgeUrl, {
            message: result.content,
            title: result.title,
            folder: result.folder,
            tag: result.tag
          }, {
            headers: { 
              "Content-Type": "application/json",
              "x-api-key": bridgeApiKey
            },
            timeout: 15000,
          });
          await sendEvent({ message: `已成功推送至 Obsidian: ${result.title}.md` });
        } catch (bridgeErr) {
          console.error('[Obsidian Sync] 同步至 Obsidian 失败:', bridgeErr);
          await sendEvent({ message: "同步至 Obsidian 失败，但提纯已完成" });
        }
      } else {
        await sendEvent({ message: "未检测到 Obsidian 配置，跳过同步。" });
      }

      await sendEvent({ step: "done", message: "全流程处理完毕！", result });

    } catch (err) {
      console.error("[Process API] 严重错误:", err);
      await sendEvent({ step: "error", message: err instanceof Error ? err.message : "服务器内部错误" });
    } finally {
      await closeStream();
    }
  })();

  return new NextResponse(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
