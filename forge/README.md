# NEARIUM FORGE
## Smart Contract Deployment Studio
### Compile. Deploy. Verify.

Nearium Forge is a SEPARATE Windows 10/11 desktop application alongside the existing Nearium Factory Deployer. The original factory deployer remains unchanged. Forge uses its own source folder, workflow, and portable executable.

## Dual-network release v0.5.0
- Choose Testnet (default) or **Mainnet · REAL NEAR** using the deployment studio's network selector. No network switch happens without verifying the corresponding RPC reports the expected `chain_id`.
- RPC providers use fixed FastNear endpoints: `https://rpc.testnet.fastnear.com` and `https://rpc.mainnet.fastnear.com`. Both must pass the read-only CI smoke test (status, chain ID, protocol configuration storage price).
- Switching networks disconnects the signer, invalidates preflight, clears account/address fields and confirmation; attempted targets remain locked during the current process session.
- The studio accepts only named `.testnet` accounts on Testnet and named `.near` accounts on Mainnet. Other suffixes and implicit accounts are not yet supported.
- Import a **FullAccess key for the selected network's account only**; never provide recovery phrases. Signing stays local.
- A Mainnet deployment requires all ordinary safeguards PLUS a separate real-funds checkbox, exact typed `MAINNET` phrase, and distinct Cancel-default native Windows Mainnet approval.
- Compiled WASM can be used on either network, but a matching code hash is not a contract audit. State migrations are NOT automatic. Always rehearse with Testnet first.
- CI runs live **read-only** checks against both networks. A Mainnet RPC verification is not proof of a completed Mainnet deployment. Real-funds signing and receipt verification require a carefully controlled separate end-to-end exercise.


**BETA v0.5.0: NEAR TESTNET + MAINNET.** Mainnet spends real NEAR. Mainnet transaction signing is implemented, but no real-funds deployment has been independently executed or audited. Use Testnet first. Supports a broad range of NEAR-compatible compiled WebAssembly contracts, including tokens, NFTs, factories, and marketplaces. Does not deploy Solidity/EVM bytecode. No guarantee of compatibility with every WASM binary.

## Current build and verification status (v0.4.0)
- v0.4.0 adds optional Docker-isolated Rust/JS/TS builds, stale-artifact invalidation, explicit WASM/hash selection, and guided code upgrade review. See the v0.4 section below; older v0.2/v0.3 instructions are preserved as legacy implementation notes.
- A successful automated test suite or Windows packaging run does **not** verify Docker Desktop configuration, real JS/TS compilation, NEAR initialization, state preservation after upgrades, or real on-chain transactions. Verify those separately on Testnet.
- Do not use a wallet with valuable funds or reuse live credentials during testing. A contract upgrade can permanently corrupt existing state even if its WASM hash matches.

## Download
1. Open https://github.com/NimbleNep141/nimble-admin-deployer/actions/workflows/nearium-forge-windows.yml
2. Select the latest successful build and download the Nearium-Forge-Windows-10-11 artifact under Artifacts.
3. Extract the ZIP and run Nearium-Forge-Windows-0.5.0.exe.
4. The portable EXE is UNSIGNED, and a SmartScreen warning may appear. Check the provided SHA256SUMS.txt and review the source and origin before running it.

## Features
- **Landing page:** Nearium Forge branding and a polished dedicated studio entry screen.
- **Compile Rust:** With Rust and cargo-near installed on Windows, select a TRUSTED Rust project directory containing Cargo.toml. Forge asks for explicit approval before running local cargo-near. Cargo build scripts and dependencies can execute native code.
- **Import WASM:** Import any appropriately compiled NEAR-compatible WebAssembly file up to 3.5 MB. JavaScript/TypeScript projects can use the optional v0.4 Docker-based Linux builder; compatible precompiled NEAR WASM can also be imported.
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
- Mainnet and Testnet network modes are experimental. Mainnet transactions spend real NEAR. The signer and deployment path have not been independently security-audited or validated with real-funds Mainnet deployment.
- Importing a key exposes it to the app process memory; no signing key is persisted or uploaded.
- No automatic transaction retries. Failed transactions can create funded keyless accounts, so verify receipts before retrying.
- Recoverable new accounts reuse the parent's public key. Keyless accounts are intentionally non-upgradeable through ordinary account-key signing.
- ABI, initializer methods, arguments and compatible storage layout cannot be inferred automatically from arbitrary WASM. User must supply correct details.
- A matching deployed code hash verifies bytes but does NOT audit contract logic or prove initializer correctness.
- Source compilation can execute build scripts or dependency code. Compile only trusted source.
- The renderer is sandboxed; remote web navigation is disabled. RPC operations use fixed, chain-checked NEAR Mainnet and Testnet endpoints.
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


## Forge v0.4.0: isolated builds, artifact review, and code upgrades

### Recommended workflow
1. Open **Compile / Import → Open Contract Project**, choose a Rust project with Cargo.toml or a JavaScript/TypeScript project with package.json.
2. Edit the source locally and click **Save Source Changes**. The old WASM artifact is explicitly cleared when you save changes, and a local source backup is made. Saving does not change deployed blockchain code.
3. For the safer build mode, install Docker Desktop separately, switch to **Linux containers**, and click **Check Docker Desktop**. Click **Build Open Project in Isolation** and approve the native Windows warning. Forge stages only selected project source files into a temporary folder, excluding wallet keys, .env files, credentials and dependency/build directories. **Original source is never mounted in the container.**
4. Forge downloads a tagged Node Linux toolchain or digest-pinned cargo-near Linux toolchain. Dependencies are downloaded in restricted Docker containers during a network-enabled setup step. The compilation step uses Docker --network none, --read-only root, --cap-drop ALL, --security-opt no-new-privileges, --pids-limit 192, and CPU/memory limits. Only an isolated, temporary project directory is mounted. Docker isolation is not a perfect malware defense and depends on correct Docker Desktop configuration. Docker Desktop is not bundled.
5. Newly built WASM files are explicitly selected when multiple are present, and **every selected WASM requires a native dialog displaying its size and SHA-256**. Forge no longer guesses the correct contract from filenames. It refuses to import an old WASM when no new artifact was produced. For isolated builds it tracks a staged-source SHA-256 fingerprint.
6. **Review Upgrade of Existing Contract** opens the existing-account deployment workflow with the initializer cleared and replacement unchecked. Connect a dedicated Testnet signer, enable code replacement, run preflight, compare old code hash and new WASM, acknowledge state-migration risks, type the exact target and confirm the Windows dialog. Only then can the blockchain transaction be submitted.

### Compatibility limits
- Rust Docker builds require a Cargo.lock file; the pinned image is sourcescan/cargo-near:0.22.0-rust-1.97.1 with a SHA-256 manifest digest specified in the app. Dependent crates are fetched during setup in a restricted container.
- JavaScript/TypeScript Docker builds use node:22.21.0-bookworm and npm build/build:contract scripts. The image is version-tagged, not registry-digest pinned. Near's officially archived/deprecated near-sdk-js supports a Linux compiler installation, so Docker can attempt it, including postinstall steps in the restricted download stage. Old SDK downloads, Node compatibility, or legacy build scripts may still fail. These scripts are untrusted code, not safe simply because they execute in a container.
- **Native** Rust and compatible native npm builds remain available for trusted projects; they are NOT sandboxed. Use isolated mode when supported. GitHub Actions tests do not validate a real Docker build, native Rust toolchain install, nor migration safety.
- The code editor supports source changes to existing files. On-chain upgrades can break persistent state, token balances, or init assumptions. Forge cannot automatically detect or perform schema migrations, so audit and test every upgrade on Testnet.
- The app remains a Windows 10/11 x64, NEAR Testnet alpha, unsigned and unaudited. Do not use for mainnet assets. Additional Docker image signature pinning, hostile-source testing and hands-on Windows end-to-end testing are required before production distribution.

- Legacy JavaScript projects that use pnpm are detected from pnpm-lock.yaml, packageManager, or near-sdk-js and compiled using Corepack/pnpm in the Linux Docker container where available. This improves compatibility but does not guarantee support for outdated SDK installer dependencies. Common secret/credential filenames are omitted from staging; always review your project because filenames cannot reliably identify every secret.


## v0.4 release acceptance checklist

Use a dedicated disposable NEAR **Testnet** account. Do not consider v0.4 production-ready until these are documented with build/version, Windows version and outcome:

1. **Release provenance:** Open the GitHub Actions workflow linked above; verify its successful run corresponds to the intended commit, download the artifact, and independently compare the EXE against `SHA256SUMS.txt`. Never treat an unverified ZIP or EXE as trusted.
2. **Docker readiness:** Start Docker Desktop in Linux container mode. In Forge, use **Check Docker Desktop** and verify Linux is detected before running a build.
3. **Rust isolated build:** Choose a trusted minimal Rust NEAR project with `Cargo.toml` and `Cargo.lock`; build with Docker isolation; verify selected WASM is newly produced, valid, and has the displayed SHA-256. Check that the application signer is disconnected before compiling.
4. **JS/TS isolated build:** Choose a trusted project with `package.json` and an appropriate contract build script. Test npm and, separately, pnpm/Corepack where applicable. Verify dependency-download and offline-build phases and that the result is actual NEAR-compatible WASM. This is not automatic support for arbitrary JS or TS.
5. **Editor safety:** Edit a disposable source file; verify confirmation, backup, and that saving clears the previously selected WASM. Confirm a recompile is required before deployment.
6. **New-account deployment:** On a new, disposable Testnet child account, review every preflight action and amount; approve explicitly; independently check contract code hash and expected initialization state after deployment.
7. **Existing-account upgrade:** On a disposable already-deployed contract, explicitly enter the existing target account. Verify the upgrade workflow cannot proceed without target selection, review of old/new WASM hashes, and migration-risk acknowledgment. Test with compatible state first; never assume a safe state migration from matching hashes alone.
8. **Failure modes:** Cancel confirmation, reject invalid or stale WASM, use incorrect network/account data, and simulate an uncertain transaction result. Verify there is no silent transaction retry and that receipts are inspected before manual recovery.
9. **Secrets and isolation:** Ensure staged Docker inputs exclude credential files and wallet directories. Docker reduces exposure; downloaded dependencies and build scripts remain untrusted. Do not call this an audited secure sandbox.
10. **Go/no-go:** Label this as **EXPERIMENTAL MAINNET** until a funded Mainnet deployment and verification have been deliberately performed under controlled conditions and an independent security review is complete.

**Known limitations:** The portable Windows executable is unsigned. Docker builds may download dependencies with network access during an isolated dependency-install phase; only the subsequent compile phase is configured to run without network access. Some deprecated `near-sdk-js` projects may fail under modern Node/Corepack or require lockfile adjustments. Upgrade compatibility is the contract author's responsibility.
