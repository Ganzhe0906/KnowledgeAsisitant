import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { processKnowledge, URL_REGEX } from "@/lib/processKnowledge";

export const maxDuration = 60;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

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

    // 1. 回复正在储存
    await sendTelegramMessage(chatId, "⏳ 正在储存...");

    // 2. 异步执行储存任务
    try {
      const result = await processKnowledge(url, true);
      // 3. 完成后回复
      await sendTelegramMessage(
        chatId,
        `✅ <b>已完成</b>\n\n<b>标题</b>: ${result.title}\n<b>内容已成功推送到 Obsidian</b>`
      );
    } catch (processError: unknown) {
      console.error("处理失败:", processError);
      const errMsg = processError instanceof Error ? processError.message : "未知错误";
      await sendTelegramMessage(chatId, `❌ <b>处理失败</b>\n\n${errMsg}`);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
