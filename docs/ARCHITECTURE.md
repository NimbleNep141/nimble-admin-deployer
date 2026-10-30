# Architecture and development decisions

## Three separations
1. **One factory**: installs child template once, accepts user `launch()` calls, records child IDs. Factory does not hold token reserves.
2. **One token and market per child**: standard NEP-141/145/148 APIs alongside `buy`, `sell`, `withdraw_proceeds` and price quotes. A token can outlive the frontend or the factory; no upgrade/access-key hooks are defined on the child.
3. **A separate graduation module in a later audited milestone**: no half-implemented DEX calls in prototype. A real Rhea migration requires wNEAR wrapping, FT storage registration, pool creation, LP locking custody, callback retry accounting, and a price-continuity proof.

## Ledger/accounting invariant

Each child has independent state:
- `reserve`: native NEAR deposited as **net buy** funds, less **gross sell** redemption.
- `fees_accrued`: cumulative outstanding buy/sell fees, less treasury withdrawals.
- `claimable[account]`: unpaid sell proceeds; a failed NEAR transfer restores the claim.
- `sold`: net token quantity delivered via buys, less token quantity redeemed via sells.
- `FT supply`: initially 1 billion, never increased by the exposed code. `storage_unregister(force=true)` and some failed `ft_transfer_call` resolutions may burn balances, so actual FT supply can decrease; this is an important known consequence of using the standard fungible token implementation.

The contract never uses a fictitious virtual NEAR reserve as liquidity. Only actual `reserve` backs redemptions. NEAR held for storage, direct donations and fees is excluded from the curve math.

## Token trading lifecycle

Buyer registers with `storage_deposit`, then calls `buy(min_tokens_out)` with attached native NEAR. The FT contract internally transfers tokens from contract-held inventory to buyer. Seller calls `sell(amount,min_near_out)` and transfers tokens internally from seller back into inventory. Seller gains an on-chain claim, and calls `withdraw_proceeds()` to pull actual NEAR.

This contract has **no graduation status transition** in v0.1, and is intentionally not described as a complete Pump.fun replacement.

## Intended version 0.2

1. Deploy/verify a small, immutable Rhea LP locker contract.
2. Decide curve allocation vs LP tokens *before* launch. A token already deployed with 100% curve inventory cannot simply promise to conjure a fresh LP allocation.
3. Add an explicit `Trading -> MigrationPending -> Graduated` state machine, with one authoritative account for migration funds.
4. Design pool reserve ratio and migration pricing simultaneously, so there is no artificial jump at the transition.
5. Make asynchronous migration steps idempotent with persistent attempts/receipts and a failure recovery plan.
6. Build on NEAR global contracts to reduce per-child WASM storage cost after checking runtime availability and tradeoffs.
7. Index NEP-297 logs for real-time charts, trading history, holders, migration status and creator performance.

## Current curve shape

Given the fixed parameter `Vtokens = 1.2B`, `Vnear = 5`, 1% buy tax, tokens can asymptotically approach the virtual 1.2B but buying is capped at 1B actual tokens. The **net NEAR in the reserve at 1B tokens sold would be approximately 25 NEAR** (exclusive of buy fees), and the marginal quoted price would be 36x the price at zero sold. The contract rejects orders that cross the 1B-token cap, rather than partially filling and refunding within the same call.

Quote amounts are integer floors: very small trades may round to zero and are rejected. No time-based anti-bot trade restriction is currently implemented.
