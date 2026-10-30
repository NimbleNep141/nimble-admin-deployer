# Security review and production release gates

**Release status: HOLD / TESTNET ONLY.** No independent security audit, Rust compilation, WASM deployment or cross-contract sandbox tests are recorded.

## High / red

1. **Factory async deployment failure recovery**: `create_account -> fund -> deploy -> new` may fail partway through, leaving 5 NEAR on a child that cannot be recreated by slug. No retry-init / cancellation / recovery state machine. Resolve before charging real users.
2. **Wallet payout callback failure recovery**: NEAR transfer callback normally restores claims on failure, but callback-gas exhaustion or a failed callback receipt could leave claims unavailable. Add durable pending withdrawal records and permissions-free repair/retry mechanisms.
3. **No production-grade liquidity graduation**: migration to Rhea pool + LP locking is *not implemented*. Marketing as graduation-enabled would be misleading.
4. **Storage solvency not integration-tested**: fund child with 5 NEAR and first-time sellers with 0.005 NEAR, but actual code size and on-chain storage/gas required must be measured under realistic high load before reserves can be considered safe.

## Medium / amber

1. **Rounding / financial math**: JS BigInt reference model passed 50k trade scenarios, but Rust `U256` code is uncompiled. Need Rust unit tests, fungible-token cross-tests and differential tests against JS model.
2. **Burnable balance through NEP-145**: users forcing `storage_unregister` can burn their balances, despite no public mint or burn methods. A guarantee of 'strictly fixed outstanding supply' therefore needs extra restrictions; initial mint total is fixed but circulating supply can fall.
3. **Factory registry storage economics**: 0.02 NEAR launch storage charge has not been measured against actual near runtime storage bytes; rates and code size must be verified before launch.
4. **No rescue of direct FT donations**: arbitrary `ft_transfer` to the contract can leave tokens outside tracked curve sales; users should sell through `sell`, never transfer tokens to the contract address.
5. **Metadata/link integrity**: optional on-chain icon string is not pinned to IPFS or accompanied by reference hashes; image uploads / moderation live off-chain.
6. **Fee wallet is immutable**: if the fee recipient's wallet is permanently lost, earned fees cannot be claimed. A multisig is recommended; don't add unconstrained owner privileges to child tokens.
7. **Factory owner controls the factory account**: template is immutable through the ABI but the account's full-access key owner can upgrade the factory bytecode. Already deployed children have no keys created by this factory, but next launches could use modified code. Publish/check deployed code hashes.
8. **Metadata and event pipeline**: standard FT emits NEP-141 transfers, but custom trading events use console logs, not structured NEP-297 trade events. Analytics needs verified parsing/indexer.

## Lower / yellow

- First seller pays 0.005 NEAR and cannot refund that through the current contract.
- Buyers must register for NEP-145 FT storage before purchase. Adapter combines actions when supported by wallet.
- Orders above remaining curve supply revert; cap-aware partial fills and refunds can improve UX later.
- Virtual reserves are not actual treasury assets; trading screens must label them accurately.
- Only native NEAR pair supported; no bridged quotes, stablecoins, taxes, creator royalties, bot defenses or user-set curve parameters.

## Release gating

Required before mainnet: compile Rust and WASM, pin lockfiles, test NEAR SDK unit + near-workspaces sandbox on actual compiled WASM, run static audit, test multi-user concurrent transactions, test failed deployment at each action boundary, test repeated failed payout callbacks and recovery, verify storage staking and contract balance at high wallet counts, test pathological token decimals/amounts and U256 overflow, inspect code and storage using explorer, commission independent NEAR security review.
