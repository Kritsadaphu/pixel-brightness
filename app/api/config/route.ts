import { NextResponse } from "next/server";

function retiredConfigRoute() {
  return NextResponse.json(
    {
      error: {
        code: "PIXEL_SERVER_ROUTE_REQUIRED",
        message: "Projects are read and saved through the authenticated Pixel Server /v1/projects API on port 4100.",
      },
    },
    { status: 410 },
  );
}

export async function GET() {
  return retiredConfigRoute();
}

export async function POST() {
  return retiredConfigRoute();
}
