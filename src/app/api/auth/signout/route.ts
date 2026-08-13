import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(
    new URL("/login", process.env.APP_URL ?? "http://localhost:3000"),
    { status: 303 },
  );
}
