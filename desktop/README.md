# Nearium Desktop Deployer (Windows 10 / 11)

A dedicated, self-contained **Windows portable executable** for the existing Nearium v0.1 factory contract, **testnet only**. No near CLI, Rust, or Node installation is needed by the Windows user. Source and builds live in the same official Nearium project repository.

## Download the app

1. Visit the [Nearium Windows Desktop Deployer build](https://github.com/Punisher530/nearium-admin-deployer/actions/workflows/windows-deployer.yml).
2. Open the latest **successful** workflow run, then scroll to **Artifacts**.
3. Download **Nearium-Windows-10-11-Deployer** and extract the ZIP.
4. Double-click \`Nearium-Deployer-Portable-0.1.0.exe\`.
5. The executable is **NOT code-signed**. Windows SmartScreen may flag an unsigned application; only run software after reviewing its origin, hash and source. Never use an unknown executable to handle real keys.

## How to use
1. Click **Verify Published Factory**. The desktop app fetches the **testnet** factory WASM from the existing GitHub Pages build and checks it against the SHA-256 manifest. This is not a security audit and the manifest comes from the same publisher.
2. Enter a **dedicated disposable NEAR Testnet** owner account, e.g. \`youraccount.testnet\`.
3. **Export that account's full-access private key** from your own wallet using its official recovery/export process, preferably from a testnet-only account. Enter the exported **ed25519** private key into the desktop app, or select a local JSON/TXT key file. Do not enter a seed phrase, mainnet key, exchange key, or any key controlling valuable funds.
4. The app verifies the public key has \`FullAccess\` for the named testnet account, and retains the key **in memory only for this session**. It is NOT stored to a file, GitHub, Nearium website, or Windows keychain. **Close the app to clear the session.** Do not leave exported key files lying around.
5. Keep the default prefix \`launchpad\` and funding \`6\` testnet NEAR or enter another valid amount.
6. Click **Check On-chain Status & Funding** to confirm factory is absent, owner exists, testnet is connected and funds are available.
7. Copy/type the displayed exact target factory account into the confirmation field, check the acknowledgement, and select **Deploy Factory**. Confirm the Windows dialog.
8. The app signs locally, and submits a **single 4-action transaction**: \`CreateAccount\`, \`Transfer\`, \`DeployContract\`, and \`FunctionCall(new({owner}))\`. It deliberately includes **no AddKey** action.
9. Check the testnet explorer and verify **zero factory access keys**, contract owner, and transactions. If the submission fails or times out, **do not retry** without carefully inspecting receipts. Failed or partial execution can strand funds in a keyless account.
10. Go back to the existing [Nearium Admin Deployer](https://punisher530.github.io/nearium-admin-deployer/) for post-deployment checks, template installation, and test token launches.

## Security constraints
- Hard-coded \`https://rpc.testnet.near.org\`; chain ID is checked and mainnet is disabled.
- Remote downloads use a fixed HTTPS GitHub Pages path; signed transactions go only to NEAR testnet RPC from the Electron **main process**.
- Chromium renderer cannot browse arbitrary web pages or access Node APIs. All actions use narrow local IPC.
- Secret input clears immediately after import; no private key is persisted. The key remains in memory until disconnect or app exit. Review the application's source before using a key.
- Before deployment the app validates owner full-access permissions, factory absence, minimum contract storage budget, and owner funds.
- No automatic retry of any factory deployment, even after an RPC error.
- Factory created with **zero access keys**. This means it may be impossible to upgrade or recover it if deployment/initialization fails.
- **UNSIGNED alpha software and UNAUDITED smart contracts. TESTNET ONLY. DO NOT USE MAINNET FUNDS.**
- Builds use GitHub's Windows runner and Electron Builder; the binary isn't independently attested or code-signed.
- For auditability, the Windows build workflow prints the SHA-256 of the generated executable and uploads it with the executable.
