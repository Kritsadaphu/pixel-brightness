import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      error: {
        code: "PIXEL_SERVER_ROUTE_REQUIRED",
        message: "Runtime status is served by the Pixel Server on port 4100 (/v1/state and /v1/health).",
      },
    },
    { status: 410 },
  );
}
