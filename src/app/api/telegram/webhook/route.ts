import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { processKnowledge, URL_REGEX } from "@/lib/processKnowledge";

export const maxDuration = 60;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

// 简单的内存缓存，用于记录已处理的 message_id，防止 Telegram 超时重试导致重复处理
const processedMessages = new Set<number>();

async function sendTelegramMessage(chatId: string | number, text: string, replyMarkup?: Record<string, unknown>) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    };
    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }
    await axios.post(url, payload);
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
}

async function handleUrlProcessing(chatId: string | number, urlToProcess: string) {
  // 1. 回复正在储存
  await sendTelegramMessage(chatId, "⏳ 正在处理，耗时取决于视频长度，请稍候...");

  // 2. 异步执行储存任务
  try {
    // 增加内部超时控制。Vercel 最大时长为 60s，设置 54s 内部超时以预留时间发送 Telegram 回复
    const timeoutMs = 54000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`处理超时（超过 ${timeoutMs / 1000} 秒）。网络或接口响应缓慢。\n可以尝试再次重试，通常会有缓存加速。`)), timeoutMs);
    });

    // 使用 Promise.race 确保即使 processKnowledge 卡住，也能在 Vercel 杀掉进程前抛出错误并回复用户
    const result = await Promise.race([
      processKnowledge(urlToProcess, true),
      timeoutPromise
    ]);

    // 3. 完成后回复
    await sendTelegramMessage(
      chatId,
      `✅ <b>已完成</b>\n\n<b>标题</b>: ${result.title}\n<b>内容已成功推送到 Obsidian</b>`
    );
  } catch (processError: unknown) {
    console.error("处理失败:", processError);
    const errMsg = processError instanceof Error ? processError.message : "未知错误";
    
    // 发送带有“重试”按钮的失败消息
    const retryKeyboard = {
      inline_keyboard: [
        [
          {
            text: "🔄 重新处理该链接",
            callback_data: `retry|${urlToProcess}`
          }
        ]
      ]
    };
    
    await sendTelegramMessage(chatId, `❌ <b>处理失败</b>\n\n<i>${errMsg}</i>`, retryKeyboard);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // 1. 处理回调查询 (Callback Query) - 点击 Inline Keyboard 按钮触发
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data; // 例如 "retry|https://..."

      if (TELEGRAM_ALLOWED_USER_ID && String(chatId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
        return NextResponse.json({ status: "unauthorized" });
      }

      if (data && data.startsWith("retry|")) {
        const urlToRetry = data.substring(6); // 截取 "retry|" 后面的 URL
        console.log(`[Telegram] 用户手动触发重试，URL: ${urlToRetry}`);
        
        // 立即向 Telegram 回复回调请求收到，防止按钮一直转圈
        if (TELEGRAM_BOT_TOKEN) {
          try {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: callbackQuery.id,
              text: "已收到重试请求，开始重新处理..."
            });
          } catch (e) {
             console.error("Answer callback query failed:", e);
          }
        }
        
        await handleUrlProcessing(chatId, urlToRetry);
      }
      return NextResponse.json({ status: "ok" });
    }

    // 2. 解析普通的 Telegram Webhook 文本消息
    const message = body.message;
    if (!message || !message.text) {
      return NextResponse.json({ status: "ok" }); // 忽略非文本消息，但返回 200 让 Telegram 知道收到了
    }

    const messageId = message.message_id;
    if (processedMessages.has(messageId)) {
      console.log(`消息 ${messageId} 已经处理过，忽略自动重试请求。`);
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

    await handleUrlProcessing(chatId, url);

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
