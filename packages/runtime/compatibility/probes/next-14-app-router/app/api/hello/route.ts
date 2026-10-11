import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ message: 'Hello from a route handler' });
}
