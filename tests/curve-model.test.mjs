// This is a JS/BigInt reference model, NOT a substitute for Rust/WASM chain tests.
import assert from 'node:assert/strict';
const UNIT = 10n ** 18n, NEAR = 10n ** 24n;
const SUPPLY = 1_000_000_000n * UNIT;
const VT = 1_200_000_000n * UNIT, VN = 5n * NEAR;
const FEE = 100n, BPS = 10_000n;
function quoteBuy(s, r, gross) {
  const fee = gross * FEE / BPS;
  const net = gross - fee;
  const tokens = (VT - s) * net / (VN + r + net);
  return { fee, net, tokens };
}
function quoteSell(s, r, amount) {
  assert(amount > 0n && amount <= s);
  const gross = (VN + r) * amount / (VT - s + amount);
  assert(gross <= r, 'reserve insufficient');
  const fee = gross * FEE / BPS;
  return { gross, fee, payout: gross - fee };
}
let seed = 0xF00D1234;
function random32() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const wallets = Array.from({ length: 50 }, () => 0n);
let sold = 0n, reserve = 0n, fees = 0n, totalClaims = 0n;
let buys = 0, sells = 0;
for (let i = 0; i < 50_000; i++) {
  const idx = random32() % wallets.length;
  if (wallets[idx] > 0n && (random32() % 3 === 0)) {
    const amount = 1n + wallets[idx] * BigInt(random32() % 1000 + 1) / 1000n;
    const clipped = amount > wallets[idx] ? wallets[idx] : amount;
    const q = quoteSell(sold, reserve, clipped);
    if (q.payout === 0n) continue;
    wallets[idx] -= clipped;
    sold -= clipped;
    reserve -= q.gross;
    fees += q.fee;
    totalClaims += q.payout;
    sells++;
  } else {
    const gross = BigInt(random32() % 100 + 1) * NEAR / 100n;
    const q = quoteBuy(sold, reserve, gross);
    if (sold + q.tokens > SUPPLY || q.tokens <= 0n) continue;
    wallets[idx] += q.tokens;
    sold += q.tokens;
    reserve += q.net;
    fees += q.fee;
    buys++;
  }
  assert(sold >= 0n && sold <= SUPPLY, 'sold bounds');
  assert(reserve >= 0n && fees >= 0n, 'reserve bounds');
  assert.equal(wallets.reduce((a,b)=>a+b,0n), sold, 'fixed circulating balance');
}
assert(buys > 500 && sells > 500);
// Buying followed by selling precisely those tokens must not earn NEAR from nothing.
for (const gross of [1n * NEAR / 1000n, NEAR, 5n * NEAR]) {
  const bought = quoteBuy(sold, reserve, gross);
  if (bought.tokens + sold > SUPPLY) continue;
  const resale = quoteSell(sold + bought.tokens, reserve + bought.net, bought.tokens);
  assert(resale.payout <= gross, 'profitable wash trade!');
}
// At genesis a buy followed by immediate sell should return less due to fees/rounding.
for (const gross of [NEAR / 1000n, NEAR, 15n * NEAR]) {
  const b = quoteBuy(0n, 0n, gross);
  const s = quoteSell(b.tokens, b.net, b.tokens);
  assert(s.payout < gross);
}
console.log(`PASS BigInt reference model: ${buys} buys, ${sells} sells, 50,000 simulated steps; reserve/fee/supply invariants and round trips`);
