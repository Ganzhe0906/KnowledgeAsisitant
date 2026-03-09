import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hostname = url.host; // 获取当前请求的域名（例如 Vercel 的域名）
  const protocol = url.protocol; // http: 或 https:

  const webhookUrl = `${protocol}//${hostname}/api/telegram/webhook`;

  if (!TELEGRAM_BOT_TOKEN) {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN is not set in environment variables." },
      { status: 400 }
    );
  }

  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(
        webhookUrl
      )}`
    );
    return NextResponse.json({
      success: true,
      message: `Webhook successfully set to ${webhookUrl}`,
      telegramResponse: response.data,
    });
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        success: false,
        error: errorMsg,
      },
      { status: 500 }
    );
  }
}
