// Proxy API route to avoid CORS issues when calling gigaverse.io from our frontend
import { NextRequest, NextResponse } from "next/server";

const BASE_URL = "https://gigaverse.io";

const ALLOWED_METHODS = new Set(["GET", "POST"]);

// Allowed endpoint prefixes — only these paths can be proxied
const ALLOWED_ENDPOINTS = [
  "/api/user/me",
  "/api/account/",
  "/api/offchain/player/energy/",
  "/api/offchain/player/activeDungeon/",
  "/api/offchain/skills",
  "/api/offchain/skills/progress/",
  "/api/offchain/static",
  "/api/offchain/recipes/player/",
  "/api/offchain/recipes/start",
  "/api/roms/player",
  "/api/roms/factory-claim",
  "/api/roms/factory/claim",
  "/api/game/dungeon/state",
  "/api/game/dungeon/today",
  "/api/game/dungeon/action",
  "/api/indexer/gameitems",
  "/api/indexer/player/gameitems/",
  "/api/items/balances",
  "/api/gear/items",
  "/api/gear/instances/",
  "/api/gigajuice/player/",
  "/api/factions/player/",
  "/api/fishing/state/",
  "/api/fishing/cards",
  "/api/fishing/action",
  "/api/fishing/sell",
];

function isEndpointAllowed(endpoint: string): boolean {
  return ALLOWED_ENDPOINTS.some(
    (allowed) => endpoint === allowed || endpoint.startsWith(allowed)
  );
}

export async function POST(req: NextRequest) {
  try {
    const { endpoint, method = "GET", body } = await req.json();
    const token = req.headers.get("x-giga-token");

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 401 });
    }

    if (!endpoint || typeof endpoint !== "string" || !endpoint.startsWith("/api/")) {
      return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
    }

    if (!ALLOWED_METHODS.has(method)) {
      return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (!isEndpointAllowed(endpoint)) {
      return NextResponse.json({ error: "Endpoint not allowed" }, { status: 403 });
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


    // Try to parse as JSON, fall back to generic error
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `Upstream returned non-JSON (${res.status})` },
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
