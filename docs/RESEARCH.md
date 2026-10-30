# NEAR launchpad research sources (checked October 26, 2026)

- NEAR Improvement Proposals and standards: NEP-141 FT, NEP-145 Storage Management, NEP-148 FT metadata: https://near.github.io/NEPs/
- Rust NEAR SDK, v5.29.1, min Rust v1.93: https://docs.rs/crate/near-sdk/latest and https://github.com/near/near-sdk-rs/releases
- NEAR contract standards, FT and storage implementations: https://docs.rs/near-contract-standards/latest/near_contract_standards/ and https://docs.rs/near-contract-standards/latest/src/near_contract_standards/fungible_token/storage_impl.rs.html
- NEAR Promise API, deployment & async callback semantics: https://docs.rs/near-sdk/latest/near_sdk/struct.Promise.html
- NEAR official Rust factory example, global contracts reference: https://github.com/near-examples/factory-rust
- NEAR official auction factory and sandbox docs: https://docs.near.org/tutorials/auction/auction-factory and https://docs.near.org/tutorials/auction/sandbox-testing
- NEAR official FT example: https://github.com/near-examples/FT
- NEAR Ecosystem Launchpads: https://nearprotocol.eco/category/launchpad
- NEARRR.fun bonding curve/curve-to-Rhea launchpad: https://nearrr.fun/docs
- Nearly NEAR launchpad architecture with Rhea DCL: https://nearly.trade/docs
- NearPad token factory / Rhea liquidity custody model: https://nearpad.family/docs
- Rhea/Ref exchange integration, pool creation and token storage registration: https://github.com/ref-finance/docs/blob/main/contracts/ref-exchange.md
- nearpool practical Rhea pool deposit/create info: https://nearpool.tech/docs

## Competitive product observations

NEAR meme launchpads are an existing competitive category. NEARRR.fun has a virtual-reserve constant-product market and Rhea graduation, meaning “bonding curve on NEAR” alone is not novel. Meme.Cooking emphasizes same-price batch auctions instead of curves; JustHoot launches directly into a Rhea pool; Nearly and NearPad directly launch into NEAR DEX markets. NEAR global-contract code reuse is a promising *cost* differentiator, while a well-audited launch mechanism with transparent reserve solvency and a verifiable DEX migration state machine could be a more meaningful trust differentiator. Confirm fees, pool contracts and protocol accounts against current official docs prior to production.
