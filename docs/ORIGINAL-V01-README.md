# NEAR native bonding curve launchpad (prototype v0.1)

**Status: SOURCE PROTOTYPE ONLY · NOT COMPILED · NOT DEPLOYED · NOT AUDITED · DO NOT PUT REAL MONEY IN THIS CODE.**

Research date: October 26, 2026. This starter focuses on keeping the first deployment milestone testable and small, rather than pretending a production-ready DEX migration and fee system exists.

## Files

- `contracts/curve-token/src/lib.rs`: a NEP-141 FT / NEP-145 storage / NEP-148 metadata token with a native-NEAR virtual-reserve constant-product bonding curve.
- `contracts/factory/src/lib.rs`: a factory deploying separate immutable child accounts (`slug.factory.testnet`).
- `web/near-adapter.ts`: example wallet-selector-compatible browser integration methods.
- `tests/curve-model.test.mjs`: independent deterministic integer-math model, 50,000 trades.
- `docs/ARCHITECTURE.md`: design decisions and formulas.
- `docs/SECURITY-GATES.md`: unresolved blockers, testing requirements and review items.
- `docs/RESEARCH.md`: references and comparisons to current NEAR launchpads.

## Mechanics

The initial fixed supply is 1,000,000,000 tokens with 18 decimals. **All one billion tokens are allocated to the curve**. There is no additional minting function, team allocation, automatic liquidity allocation, DEX graduation, transfer tax, reflection, upgrade, blacklist, or pausing mechanism.

Each token contract is a conventional NEP-141 token and a bonding-curve market. Buyers pay **native NEAR** and must be registered with `storage_deposit` before buying. The frontend adapter can combine registration and buying in a wallet transaction. Tokens are held initially by the token contract and moved to and from buyers/sellers with the FT standard's internal transfer logic.

A sell credits claimable native NEAR, withdrawable with `withdraw_proceeds()` via an asynchronous transfer and failure callback. On first sell the wallet attaches an additional **0.005 NEAR** to fund the seller's payout-ledger storage, and on subsequent sells it attaches **one yoctoNEAR**. This 0.005 NEAR is not a trading fee and is not refundable in this prototype. Each buy and sell carries a fixed 1% protocol trading fee. Only the immutable `fee_recipient` set by factory deployment can request withdrawal of accrued fees.

### Curve economics

The contract uses *virtual*, not spendable, initial NEAR reserves:

- `VIRTUAL_NEAR = 5 * 10^24` yoctoNEAR, representing 5 NEAR.
- `VIRTUAL_TOKENS = 1,200,000,000 * 10^18` token base units.
- `TOTAL_SUPPLY = 1,000,000,000 * 10^18`.
- `FEE_BPS = 100` (1%).

With `R = real net NEAR raised`, `S = tokens sold`, `V = virtual token reserve`, `N = virtual NEAR reserve`, and `d = trade amount`, the **buy** quote is:

```
net_near = gross_near - floor(gross_near * 100 / 10000)
tokens_out = floor((V - S) * net_near / (N + R + net_near))
```

and the **sell** quote:

```
gross_near_back = floor((N + R) * token_in / ((V - S) + token_in))
net_near_back = gross_near_back - floor(gross_near_back * 100 / 10000)
```

All intermediate multiplication uses U256 arithmetic to avoid overflowing `u128`. The curve refuses buys that exceed its fixed supply (users should reduce their attached NEAR). At full sale the curve is still reversible: holders may sell tokens back and reopen curve inventory. There is **no state where funds are deliberately frozen for a future graduation process**.

**The quoted price has market impact**. The virtual reserve is an equation parameter, not real collateral or a guarantee of NEAR available for withdrawals.

## Prerequisites

On a development machine with external package access:

1. Rust 1.93+ and `rustup target add wasm32-unknown-unknown`.
2. `cargo-near` and a NEAR testnet account with sufficient testnet NEAR.
3. Node 22+ for the mathematical reference tests.
4. A compatible NEAR wallet integration from the official Wallet Selector ecosystem.

SDK pins: `near-sdk = =5.29.1`; `near-contract-standards = =5.29.1`.

## Test and build

```bash
npm run test:model
(cd contracts/curve-token && cargo test && cargo near build non-reproducible-wasm --no-abi)
(cd contracts/factory && cargo test && cargo near build non-reproducible-wasm --no-abi)
```

The path/name for output WASM depends on your `cargo-near` version. **Do not infer that builds pass from this README**. This environment did not provide Rust or cargo, so neither native Rust compilation nor WASM compilation nor NEAR sandbox simulation has been performed. The BigInt model did run and passed its checks, and the TypeScript adapter passed a standalone TypeScript type-check (`tsc --noEmit --target ES2022 --lib es2022,dom --module esnext --moduleResolution bundler`). Neither check is evidence that the uncompiled Rust contract matches the model.

## Testnet deployment plan

1. Build token WASM (curve-token) and factory WASM.
2. Create/fund a new NEAR testnet account that will be the factory account. Deploy factory WASM, then call `new({"owner":"YOUR_OWNER.testnet"})`.
3. Encode the compiled curve-token WASM bytes in base64. Owner calls `install_template({"code":"BASE64_WASM"})` with **enough attached testnet NEAR** to cover ~the token WASM byte length times `env::storage_byte_cost()`, plus a margin. This operation is one-time and cannot be updated through the published interface.
4. On the website, set `factoryId` to the deployed factory account. A token creator calls `launch({"slug":"pepe","name":"Pepe Test","symbol":"PEPE","icon":null})`, attaching exactly **5.02 NEAR** on testnet. In this prototype the 5 NEAR is child-account funding, and 0.02 NEAR is retained for factory indexing/storage, not a profit fee.
5. Check `get_launch({"slug":"pepe"})` until `status` shows `deployed`; `pending` or `failed` must not be displayed as live token listings. If deployment is reported as `failed`, **do not retry by paying for another launch** before investigating the child account and receipts.
6. The child ID will be `pepe.FACTORY_ID`. Use `ft_metadata`, `get_curve`, `quote_buy`, `quote_sell`, `ft_balance_of`, `storage_balance_bounds`, and `claimable_proceeds` to power the UI.
7. Test `storage_deposit` + `buy`, `sell`, `withdraw_proceeds`, token transfers, adversarial inputs, and callback failures using tiny testnet values.

## Website adapter usage

```ts
import { RPC, launchToken, quoteBuy, buyTokens, sellTokens, withdrawProceeds } from './web/near-adapter';

// wallet = connected wallet-selector wallet, following WalletAdapter interface
await launchToken(wallet, 'factory-name.testnet', {
  slug: 'pepe', name: 'Pepe Test', symbol: 'PEPE', icon: null
});

const tokenId = 'pepe.factory-name.testnet';
const quote = await quoteBuy(RPC.testnet, tokenId, '0.2');
console.log('Raw tokens quoted:', quote.tokens_out);
await buyTokens(wallet, RPC.testnet, tokenId, 'my-wallet.testnet', '0.2', 100);
await sellTokens(wallet, RPC.testnet, tokenId, 'my-wallet.testnet', '500000', 100);
await withdrawProceeds(wallet, tokenId);
```

Browser `view()` uses JSON RPC with `fetch` and `btoa`. Plug the `WalletAdapter` calls into your actual wallet-selector instance. Never use floating point to construct yoctoNEAR values and never send a buy with `min_tokens_out: "0"` from a real frontend.

## Product limits

- Not Pump.fun graduation parity; Rhea integration is **not implemented**.
- Child creation is an async multi-action deployment; **failed initialization can leave an existing funded child account**. This is a release blocker until recovery / idempotent deployment is built and tested.
- First-seller storage deposit is not refundable.
- UI has no hosted chart, token indexing database, moderation, image uploader, wallet onboarding screens, or indexer in this package.
- No independent security audit has been performed; do not deploy to mainnet.
- No on-chain locked liquidity is claimed (there is no DEX pool yet).

## Sources

See `docs/RESEARCH.md` for the standards and reference launchpads consulted.
