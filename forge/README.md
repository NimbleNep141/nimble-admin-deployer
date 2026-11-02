# NEARIUM FORGE
## Smart Contract Deployment Studio
### Compile. Deploy. Verify.

Nearium Forge is a SEPARATE Windows 10/11 desktop application alongside the existing Nearium Factory Deployer. The original factory deployer remains unchanged. Forge uses its own source folder, workflow, and portable executable.

**ALPHA: NEAR TESTNET ONLY.** Supports a broad range of NEAR-compatible compiled WebAssembly contracts, including tokens, NFTs, factories, and marketplaces. Does not deploy Solidity/EVM bytecode. No guarantee of compatibility with every WASM binary.

## Download
1. Open https://github.com/Punisher530/nearium-admin-deployer/actions/workflows/nearium-forge-windows.yml
2. Select the latest successful build and download the Nearium-Forge-Windows-10-11 artifact under Artifacts.
3. Extract the ZIP and run Nearium-Forge-Windows-0.3.0.exe.
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

## Official app logo
The original user-provided transparent Nearium Forge hexagonal N PNG (600 × 561 pixels) is bundled unchanged in `src/assets/nearium-forge-logo.png`, and displayed in the header, landing-page hero, app window icon and HTML favicon. A matching multi-resolution Windows ICO is bundled in `src/assets/nearium-forge-icon.ico` and configured as the executable icon. GitHub CI verifies the PNG's SHA-256 to ensure it matches the supplied artwork.

## Integrated NEAR Compiler Manager (v0.2.0)
Open **Compile / Import** and select **Check Compiler** or **Install / Repair Compiler Tools**.
- Windows 10/11 x64 only. Native confirmation (Cancel by default) is mandatory.
- Rustup 1.29.0 is downloaded from the official Rust HTTPS archive and checked against that archive's published SHA-256.
- Rust 1.97.1 with wasm32-unknown-unknown is installed for the current Windows user. Microsoft's C++ Build Tools might be required and are not installed automatically.
- The cargo-near 0.22.0 Windows x64 archive is downloaded from an exact official NEAR GitHub release, verified against the SHA-256 pinned in compiler-manager.cjs, and extracted under the current Windows user's Forge app data.
- Compiler setup and compilation require disconnection of the local signer; tools do not receive wallet secrets or deploy contracts.
- Compiling Rust source can execute arbitrary native build scripts under your Windows account. Builds are NOT sandboxed. Do not compile untrusted repositories.
- Local setup requires an internet connection. Automated tests check code and the Windows build but do not prove the entire toolchain has been installed or that compilation works end-to-end on a user's PC.

## Source Editor and JavaScript/TypeScript Contract Builds (v0.3.0)

The **Compile / Import** view now includes **Local Contract Code Editor** and **JavaScript / TypeScript Contract Builder**.

### Edit source
- Click **Open Contract Project**, select a folder containing Cargo.toml or package.json, and choose a source file.
- Edit Rust (.rs), JS (.js/.jsx), TS (.ts/.tsx), or project configuration (.json/.toml).
- Click **Save Source Changes**. Forge confirms natively, checks for outside changes, and saves a pre-edit backup in the current Windows user's Forge data under source-backups.
- Project file listings exclude node_modules, build artifacts, symlinks and paths outside the project. Individual editable files are limited to 1 MB.
- Local source edits **never** update deployed blockchain contracts. Compile the new WASM, then explicitly choose **Deploy to my existing account** and approve replacement after preflight; state migrations are NOT automatic.

### Legacy JS/TS contracts
- NEAR's official near-sdk-js contract repository is **archived and explicitly deprecated**.
- Its official 2.x post-install compiler explicitly does **not** support native Windows (`SUPPORTED_PLATFORMS` is linux/darwin). Forge detects that dependency in package.json and refuses this Windows build path. Compile legacy SDK projects under trusted WSL/Linux and import the resulting WASM. Other npm projects with a Windows-compatible NEAR WASM build script remain supported. This optional feature is suitable only for exploring existing legacy JavaScript/TypeScript contracts on **Testnet**. Use reviewed Rust contracts for real assets.
- Install managed Node.js v22.21.0 using the in-app button. It downloads the fixed official Windows x64 ZIP and SHA256 manifest from nodejs.org, validates the download, and extracts into your Windows user-profile Forge compiler directory.
- Select a JS/TS project with a package.json. Forge supports package scripts named `build:contract` or `build` that produce NEAR-compatible WASM. It does not translate arbitrary JavaScript code into a contract.
- Click **Install Dependencies** when needed: `npm ci --ignore-scripts` if a package-lock exists, or `npm install --ignore-scripts` otherwise. npm lifecycle scripts are suppressed during installation but the explicitly selected build script can run native commands. Dependencies might still be unsafe.
- Click **Compile JavaScript / TypeScript**, review the exact project build script in the native approval dialog, and select a generated WASM if multiple artifacts were created. Forge loads the generated WASM into the same deployment pipeline as Rust.
- The user's signer **must be disconnected** for installation, dependency setup or compilation. This is a guardrail, NOT a secure sandbox. JS/TS build scripts run with the user's Windows privileges. Do not build untrusted projects.
- Package-manager monorepos that require pnpm/yarn or SDK postinstall hooks may need separate developer setup; the in-app npm workflow intentionally does not execute lifecycle scripts during dependency installation.
- Compiler manager, editor, and build workflows do not transmit source or secret keys to Nearium servers. npm itself downloads dependencies from its configured registry; Windows and NPM environment configurations may affect that registry.
- This feature is experimental. The portable Windows build and automated tests do not establish an end-to-end verified installation/build, a malware-free compiler, or a smart contract audit.
