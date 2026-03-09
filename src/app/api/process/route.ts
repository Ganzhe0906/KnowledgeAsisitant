import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { processKnowledge, URL_REGEX } from "@/lib/processKnowledge";

// ============ 类型定义 ============

interface ProcessRequestPayload {
  url: string;
  isDirectMode?: boolean;
}

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

      try {
        await processKnowledge(trimmedUrl, isDirectMode, sendEvent);
      } catch (apiErr: unknown) {
        let errMsg = "请求 AI 服务时出错";
        if (axios.isAxiosError(apiErr)) {
          errMsg = apiErr.response?.data?.error?.message || apiErr.message || errMsg;
        } else if (apiErr instanceof Error) {
          errMsg = apiErr.message;
        }
        await sendEvent({ step: "error", message: `处理失败: ${errMsg}` });
      }
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
