# NEARIUM FORGE
## Smart Contract Deployment Studio
### Compile. Deploy. Verify.

Nearium Forge is a SEPARATE Windows 10/11 desktop application alongside the existing Nearium Factory Deployer. The original factory deployer remains unchanged. Forge uses its own source folder, workflow, and portable executable.

**ALPHA: NEAR TESTNET ONLY.** Supports a broad range of NEAR-compatible compiled WebAssembly contracts, including tokens, NFTs, factories, and marketplaces. Does not deploy Solidity/EVM bytecode. No guarantee of compatibility with every WASM binary.

## Download
1. Open https://github.com/Punisher530/nearium-admin-deployer/actions/workflows/nearium-forge-windows.yml
2. Select the latest successful build and download the Nearium-Forge-Windows-10-11 artifact under Artifacts.
3. Extract the ZIP and run Nearium-Forge-Windows-0.1.0.exe.
4. The portable EXE is UNSIGNED, and a SmartScreen warning may appear. Check the provided SHA256SUMS.txt and review the source and origin before running it.

## Features
- **Landing page:** Nearium Forge branding and a polished dedicated studio entry screen.
- **Compile Rust:** With Rust and cargo-near installed on Windows, select a TRUSTED Rust project directory containing Cargo.toml. Forge asks for explicit approval before running local cargo-near. Cargo build scripts and dependencies can execute native code.
- **Import WASM:** Import any appropriately compiled NEAR-compatible WebAssembly file up to 3.5 MB. Other languages (including NEAR JavaScript/TypeScript) must be compiled with their own tooling first.
- **New child account:** Creates prefix.owner.testnet, funds the account, installs the chosen WASM, and optionally calls an initializer method. Recoverable mode adds the existing signer public key to the child. Advanced keyless mode skips AddKey and should be used only after careful consideration.
- **Existing account:** Replaces/install code on the locally signed account itself; requires a FullAccess key. Existing code replacement requires an explicit checkbox. This cannot bypass an account's key restrictions.
- **Init:** Optional contract method, JSON argument object, gas and payable deposit.
- **Verify:** Independent read-only on-chain account inspection and deployed code-hash comparison against the selected WASM.
- **Saved contracts:** Compact contract-library dropdown. Save copies of WASM and deployment presets locally; load or remove entries later. Signing keys are NEVER stored in the library.

## How to use
1. Run Forge, and click Launch Deployment Studio.
2. Import a NEAR-compatible .wasm contract, or build a trusted Rust project using an installed local toolchain.
3. Enter a disposable NEAR Testnet owner account. Connect an exported FullAccess ed25519 key or select its local JSON credential file. Never use a recovery phrase or valuable mainnet credentials.
4. Select New Child Account or Existing Account. Set account, funding, ownership, and optional initializer arguments correctly for that contract.
5. Click Run Preflight Check. Inspect the exact target, WASM SHA-256, actions and balance.
6. Type the FULL target address, check the acknowledgment and click Deploy Contract. A native Windows approval appears with Cancel selected by default.
7. Inspect the result and then use Verify On-chain to check its code hash, balance and access keys.
8. Save the selected WASM and preset using My Contracts to restore them in future sessions.

## Security notes
- Testnet only and experimental. Not externally audited or tested against every contract ABI.
- Importing a key exposes it to the app process memory; no signing key is persisted or uploaded.
- No automatic transaction retries. Failed transactions can create funded keyless accounts, so verify receipts before retrying.
- Recoverable new accounts reuse the parent's public key. Keyless accounts are intentionally non-upgradeable through ordinary account-key signing.
- ABI, initializer methods, arguments and compatible storage layout cannot be inferred automatically from arbitrary WASM. User must supply correct details.
- A matching deployed code hash verifies bytes but does NOT audit contract logic or prove initializer correctness.
- Source compilation can execute build scripts or dependency code. Compile only trusted source.
- The renderer is sandboxed; remote web navigation is disabled. RPC operations use fixed NEAR testnet.
- Saved contract entries and WASM are stored in the Windows user profile; they are not encrypted. No keys are serialized.
- CI syntax/unit tests and a successful Windows build are not substitutes for an end-to-end testnet deployment and security audit.

## Source layout
- forge/src/main.cjs: Windows desktop backend, NEAR RPC, local signing and compilation
- forge/src/core.cjs: exact funds, contract address, initializer and transaction validation
- forge/src/library.cjs: local WASM and preset library
- forge/src/index.html, style.css, renderer.js: landing page and studio workspace
- forge/tests: safety and UI checks
- .github/workflows/nearium-forge-windows.yml: separate Windows portable build

Nearium Forge is distinct from the original desktop factory deployer under desktop/.
