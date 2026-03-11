import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export const maxDuration = 60; // Vercel 免费版/Hobby 最高 60 秒（如果是旧版可能 10s，Pro 是 300s）

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_KEY) {
      return NextResponse.json({ error: "Missing GEMINI_API_KEY in Vercel environment" }, { status: 500 });
    }

    // 将请求转发给 Google，锁定模型为 gemini-3-flash-preview
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_KEY}`,
      body,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 55000, // 给 Vercel 留点缓冲时间
      }
    );

    return NextResponse.json(response.data);
  } catch (error: any) {
    console.error("Gemini Proxy Error:", error.response?.data || error.message);
    return NextResponse.json(
      error.response?.data || { error: "Internal Proxy Error", message: error.message },
      { status: error.response?.status || 500 }
    );
  }
}
