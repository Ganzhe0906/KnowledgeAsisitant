import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { processKnowledge } from "@/lib/processKnowledge";
import { verifySignatureAppRouter } from "@upstash/qstash/dist/nextjs";

export const maxDuration = 60; // 即使交给队列，单个队列请求如果在 Vercel 免费版也会被杀，但 QStash 会通过重试机制不断尝试。如果是付费 Vercel 可设到 300

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegramMessage(chatId: string | number, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

async function handler(req: NextRequest) {
  try {
    const body = await req.json();
    const { url, chatId, isDirectMode } = body;

    if (!url || !chatId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log(`[QStash Queue] 开始处理任务, URL: ${url}, ChatID: ${chatId}`);

    try {
      // 执行耗时最长的核心任务
      const result = await processKnowledge(url, isDirectMode);

      // 处理成功，通过 Telegram 发送最终结果
      await sendTelegramMessage(
        chatId,
        `✅ <b>已完成</b>\n\n<b>标题</b>: ${result.title}\n<b>内容已成功推送到 Obsidian</b>`
      );
      
      console.log(`[QStash Queue] 任务成功完成: ${url}`);
      return NextResponse.json({ status: "success" });

    } catch (processError: unknown) {
      console.error("[QStash Queue] 处理失败:", processError);
      
      const errMsg = processError instanceof Error ? processError.message : "未知错误";
      
      // 获取当前是第几次重试 (QStash Header)
      const retriedCountStr = req.headers.get("Upstash-Retried");
      const retriedCount = retriedCountStr ? parseInt(retriedCountStr, 10) : 0;
      const maxRetries = 3; // 与 webhook 接口配置的 retries: 3 保持一致
      
      // 如果发生特定错误，可能不需要 QStash 重试（例如用户发了无效网址或 API 没配），则返回 200，并告知用户
      // 如果是超时等网络原因，抛出错误，QStash 会接收到 500 然后启动重试机制 (最多 retry 设定的次数)
      const isFatalError = errMsg.includes("URL 格式不正确") || errMsg.includes("未配置 API Key");
      
      if (isFatalError) {
        await sendTelegramMessage(chatId, `❌ <b>处理失败</b> (不可恢复错误)\n\n${errMsg}`);
        return NextResponse.json({ status: "failed_non_retryable", error: errMsg }, { status: 200 }); // 返回 200 阻止 QStash 再次重试
      }
      
      // 处理可重试错误（例如超时）的 Telegram 通知
      if (retriedCount < maxRetries) {
        const nextTry = retriedCount + 1;
        await sendTelegramMessage(chatId, `⚠️ <b>处理遇到问题 (如超时或网络波动)</b>\n\n系统即将自动进行第 ${nextTry} 次尝试 (共 ${maxRetries} 次)\n\n<i>详情: ${errMsg}</i>`);
      } else {
        await sendTelegramMessage(chatId, `❌ <b>最终失败</b>\n\n已达到最大重试次数 (${maxRetries} 次)，任务已放弃。\n\n<i>最后一次错误: ${errMsg}</i>`);
      }
      
      throw processError; // 让 QStash 捕获，触发退避重试
    }
    
  } catch (error) {
    console.error("[QStash Queue] 服务器内部错误:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// QStash 官方推荐使用 verifySignatureAppRouter 包装处理函数，用于验证请求必须且只能来自 Upstash QStash，保证安全。
export const POST = verifySignatureAppRouter(handler);
