import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
// 为了通过 QStash 实现真正的异步并避免 Vercel 平台超时限制，将 processKnowledge 移至 process-queue 接口执行
import { URL_REGEX } from "@/lib/processKnowledge";
import { Client } from "@upstash/qstash";

export const maxDuration = 60;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;

// 简单的内存缓存，用于记录已处理的 message_id，防止 Telegram 超时重试导致重复处理
const processedMessages = new Set<number>();

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // 解析 Telegram Webhook 数据
    const message = body.message;
    if (!message || !message.text) {
      return NextResponse.json({ status: "ok" }); // 忽略非文本消息，但返回 200 让 Telegram 知道收到了
    }

    const messageId = message.message_id;
    if (processedMessages.has(messageId)) {
      console.log(`消息 ${messageId} 已经处理过，忽略重试请求。`);
      return NextResponse.json({ status: "ok" });
    }
    processedMessages.add(messageId);
    
    // 保持内存不会无限增长
    if (processedMessages.size > 1000) {
      const iterator = processedMessages.values();
      const firstValue = iterator.next().value;
      if (firstValue !== undefined) {
        processedMessages.delete(firstValue);
      }
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    // 鉴权检查
    if (TELEGRAM_ALLOWED_USER_ID && String(chatId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
      console.warn(`未授权的 Telegram User ID 尝试使用: ${chatId}`);
      return NextResponse.json({ status: "unauthorized" });
    }

    // 检查是否包含 URL
    const urls = text.match(URL_REGEX) || text.match(/https?:\/\/[^\s]+/);
    const url = urls ? urls[0] : null;

    if (!url) {
      await sendTelegramMessage(chatId, "未检测到有效的网址，请直接发送包含网址的消息。");
      return NextResponse.json({ status: "ok" });
    }

    if (!QSTASH_TOKEN) {
      await sendTelegramMessage(chatId, "❌ 未配置 QSTASH_TOKEN 环境变量，无法启用后台队列。");
      return NextResponse.json({ status: "error", error: "Missing QSTASH_TOKEN" }, { status: 500 });
    }

    // 1. 回复正在加入队列
    await sendTelegramMessage(chatId, "⏳ 正在排队处理中，耗时取决于视频长度，请稍候...");

    // 2. 将耗时的储存任务发送给 Upstash QStash
    const qstashClient = new Client({ token: QSTASH_TOKEN });
    
    // 获取当前请求的主机名作为回调地址。生产环境可能需要通过配置或者 req.url 动态获取。
    const protocol = req.headers.get("x-forwarded-proto") || "https";
    const host = req.headers.get("host");
    let baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${protocol}://${host}`;
    
    // 强制清理可能带有的尾部斜杠
    baseUrl = baseUrl.replace(/\/$/, "");

    try {
      await qstashClient.publishJSON({
        url: `${baseUrl}/api/process-queue`,
        body: {
          url: url,
          chatId: chatId,
          isDirectMode: true // 直通模式
        },
        // 这里配置 QStash 重试次数，设为 3 次
        // QStash 会使用指数退避策略在失败后重试
        retries: 3
      });
      console.log("已成功发送到 QStash 队列", `${baseUrl}/api/process-queue`);
    } catch (qErr) {
      console.error("QStash 发送失败:", qErr);
      await sendTelegramMessage(chatId, "❌ <b>排队失败</b>，请检查 QStash 配置或服务状态。");
    }

    // 3. 立即返回 200，让 Telegram 停止等待
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
