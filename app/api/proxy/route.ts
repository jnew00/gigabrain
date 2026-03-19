// Proxy API route to avoid CORS issues when calling gigaverse.io from our frontend
import { NextRequest, NextResponse } from "next/server";

const BASE_URL = "https://gigaverse.io";

export async function POST(req: NextRequest) {
  try {
    const { endpoint, method = "GET", body } = await req.json();
    const token = req.headers.get("x-giga-token");

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 401 });
    }

    if (!endpoint || !endpoint.startsWith("/api/")) {
      return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
    }

    const fetchOpts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "*/*",
      },
    };

    if (method === "POST" && body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE_URL}${endpoint}`, fetchOpts);
    const text = await res.text();

    // Try to parse as JSON, fall back to wrapping as error
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `Upstream returned non-JSON (${res.status})`, body: text.slice(0, 200) },
        { status: res.status >= 400 ? res.status : 502 }
      );
    }

    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Proxy error" },
      { status: 500 }
    );
  }
}
