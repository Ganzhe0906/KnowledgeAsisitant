import { NextRequest, NextResponse } from "next/server";

/**
 * 模拟 Obsidian Bridge 接收端 API
 * 用于本地闭环测试，接收 POST 请求后打印 Payload 并返回 success
 */

interface BridgePayload {
  title?: string;
  tag?: string;
  content?: string;
  folder?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const payload = body as BridgePayload;

    console.log("[Mock Bridge] 收到推送 Payload:", {
      title: payload.title,
      tag: payload.tag,
      content: payload.content?.slice(0, 80) + (payload.content && payload.content.length > 80 ? "..." : ""),
      folder: payload.folder,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 400 });
  }
}
