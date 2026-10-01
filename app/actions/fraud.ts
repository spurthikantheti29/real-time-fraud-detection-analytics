"use server"

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { fraudTransaction } from "@/lib/db/schema"
import { and, desc, eq, sql, gte } from "drizzle-orm"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error("Unauthorized")
  return session.user.id
}

export type Transaction = typeof fraudTransaction.$inferSelect

export async function getRecentTransactions(limit = 50): Promise<Transaction[]> {
  const userId = await getUserId()
  return db
    .select()
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))
    .orderBy(desc(fraudTransaction.createdAt))
    .limit(limit)
}

export async function getStats() {
  const userId = await getUserId()
  const rows = await db
    .select({
      total: sql<number>`cast(count(*) as integer)`,
      fraud: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then 1 else 0 end), 0) as integer)`,
      blocked: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.status} = 'blocked' then 1 else 0 end), 0) as integer)`,
      review: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.status} = 'review' then 1 else 0 end), 0) as integer)`,
      volume: sql<number>`cast(coalesce(sum(${fraudTransaction.amount}), 0) as real)`,
      fraudVolume: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then ${fraudTransaction.amount} else 0 end), 0) as real)`,
      avgRisk: sql<number>`cast(coalesce(avg(${fraudTransaction.riskScore}), 0) as real)`,
    })
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))
  return rows[0]
}

export async function getRiskOverTime() {
  const userId = await getUserId()
  return db
    .select({
      day: sql<string>`strftime('%m-%d', datetime(${fraudTransaction.createdAt} / 1000, 'unixepoch'))`,
      bucket: sql<string>`date(datetime(${fraudTransaction.createdAt} / 1000, 'unixepoch'))`,
      fraud: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then 1 else 0 end), 0) as integer)`,
      legit: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then 0 else 1 end), 0) as integer)`,
      avgRisk: sql<number>`cast(round(coalesce(avg(${fraudTransaction.riskScore}), 0)) as integer)`,
    })
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))
    .groupBy(sql`date(datetime(${fraudTransaction.createdAt} / 1000, 'unixepoch'))`)
    .orderBy(sql`date(datetime(${fraudTransaction.createdAt} / 1000, 'unixepoch'))`)
}

export async function getByCategory() {
  const userId = await getUserId()
  return db
    .select({
      category: fraudTransaction.category,
      count: sql<number>`cast(count(*) as integer)`,
      fraud: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then 1 else 0 end), 0) as integer)`,
    })
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))
    .groupBy(fraudTransaction.category)
    .orderBy(desc(sql`count(*)`))
}

export async function getByChannel() {
  const userId = await getUserId()
  return db
    .select({
      channel: fraudTransaction.channel,
      count: sql<number>`cast(count(*) as integer)`,
      fraud: sql<number>`cast(coalesce(sum(case when ${fraudTransaction.isFraud} then 1 else 0 end), 0) as integer)`,
    })
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))
    .groupBy(fraudTransaction.channel)
    .orderBy(desc(sql`count(*)`))
}

const MERCHANTS = [
  "Amazon", "Apple Store", "Walmart", "Steam", "Uber", "Netflix", "Best Buy",
  "Target", "Shell", "Delta Air", "Booking.com", "Coinbase", "PayPal", "Etsy",
]
const CATEGORIES = ["Retail", "Travel", "Digital Goods", "Groceries", "Crypto", "Gaming", "Fuel"]
const CHANNELS = ["Online", "In-store", "Mobile App", "ATM", "Recurring"]
const COUNTRIES = ["US", "GB", "DE", "NG", "RU", "BR", "IN", "CN", "FR", "CA"]
const HIGH_RISK_COUNTRIES = new Set(["NG", "RU", "CN"])

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function makeTxn(userId: string, daysAgo: number) {
  const country = pick(COUNTRIES)
  const channel = pick(CHANNELS)
  const category = pick(CATEGORIES)
  const amount = Math.round((Math.random() * 4800 + 5) * 100) / 100

  let risk = Math.floor(Math.random() * 45)
  if (HIGH_RISK_COUNTRIES.has(country)) risk += 30
  if (amount > 2500) risk += 15
  if (channel === "Online" || channel === "ATM") risk += 10
  if (category === "Crypto") risk += 12
  risk = Math.min(99, risk)

  const isFraud = risk >= 70
  const status = risk >= 80 ? "blocked" : risk >= 60 ? "review" : "approved"

  const created = new Date()
  created.setDate(created.getDate() - daysAgo)
  created.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60))

  return {
    userId,
    txnRef: "TXN-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    amount: Number(amount.toFixed(2)),
    currency: "USD",
    merchant: pick(MERCHANTS),
    category,
    channel,
    country,
    cardLast4: String(Math.floor(1000 + Math.random() * 9000)),
    riskScore: risk,
    status,
    isFraud,
    createdAt: created,
  }
}

export async function seedTransactions() {
  const userId = await getUserId()
  const existing = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(fraudTransaction)
    .where(eq(fraudTransaction.userId, userId))

  if (existing[0].count > 0) return { seeded: 0 }

  const rows = []
  for (let d = 13; d >= 0; d--) {
    const perDay = 12 + Math.floor(Math.random() * 18)
    for (let i = 0; i < perDay; i++) rows.push(makeTxn(userId, d))
  }
  await db.insert(fraudTransaction).values(rows)
  revalidatePath("/")
  return { seeded: rows.length }
}

// Simulate a new incoming transaction in real time.
export async function ingestTransaction() {
  const userId = await getUserId()
  const [row] = await db.insert(fraudTransaction).values(makeTxn(userId, 0)).returning()
  revalidatePath("/")
  return row
}

export async function getLiveFeed() {
  const userId = await getUserId()
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24)
  return db
    .select()
    .from(fraudTransaction)
    .where(and(eq(fraudTransaction.userId, userId), gte(fraudTransaction.createdAt, since)))
    .orderBy(desc(fraudTransaction.createdAt))
    .limit(15)
}
