# Nearium v0.2 admin security review

| Risk | Severity | How handled |
|---|---|---|
| Private key exposure | High | No keys in repo, browser app, CI, or server. Wallet signs directly. |
| Replacing live contract unexpectedly | High | create-only factory flow rejects existing account; factory created without access keys. |
| Admin impersonation | High | On-chain factory checks predecessor owner for install_template; browser owner verification merely convenience. |
| Supply-chain substitution | High | v0.1 source bundled, CI builds; SHA256 hash check + Git SHA; still requires review of CI and dependencies. |
| Wallet incompatible with deploy actions | High | Fail with wallet error; supports no fallback to backend custody. Needs end-to-end wallet test. |
| Partial child launch leaves stranded funds | Critical | Inherited from v0.1. No automatic retry. Must be fixed before production. |
| Curve payout callback and reserve accounting | Critical | Inherited from v0.1. Not resolved. No mainnet. |
| Irreversible template installation | High | Displays hash, confirmations, and on-chain is_template_installed. |
| Mistaking wallet redirect for success | High | UI reports uncertain state and only confirms after on-chain view. |
| Accidentally connecting to mainnet | High | Hardcoded testnet wallet, account suffix, RPC, manifest chain, UI label. |
| Unauthenticated access to admin HTML | Medium | Static UI is publicly readable; cannot authorize owner blockchain actions. Optional external website access policy recommended. |
| Signing package failures after redirect | High | Requires review of explorer receipts before another attempt; no retries. |
| DEX graduation missing | High | Not represented as implemented. |

Release gate: FAIL / HOLD until Rust compile, workspaces integration tests, callback and reserve security hardening, testnet end-to-end exercise with an actually supported wallet, reproducible WASM builds, and independent audit.
