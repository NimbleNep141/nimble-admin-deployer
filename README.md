# Nearium Admin Deployer v0.2 (website launcher)

**Status: IMPLEMENTED SOURCE + TESTED JS CORE. NOT COMPILED, HOSTED, OR BLOCKCHAIN-TESTED. NEAR TESTNET ONLY.**

This project combines the **unchanged original v0.1 NEAR Rust contracts** with a new browser-based owner-signed administrator and a GitHub Actions cloud-build workflow. It is designed to be linked from **BuildAI.space**, where Nearium is already hosted. You do **not** need Rust or Node on your Windows PC if you use the GitHub cloud route.

## Contents

- `contracts/factory/src/lib.rs` and `contracts/curve-token/src/lib.rs`: exact v0.1 Rust source, copied intact from your previous package.
- `admin/index.html`, `admin/src/main.js`, `admin/src/core.js`, `admin/src/style.css`: real admin UI and NEAR RPC / wallet transaction implementation.
- `.github/workflows/testnet-build-and-site.yml`: Rust compile/test, JS tests, SHA-256 manifest, GitHub Pages publishing (fails closed if compilation fails).
- `scripts/publish_manifest.py`: checks and packages built WASM files with SHA-256 and source commit.
- `admin/tests/core.test.mjs`: JavaScript unit tests for account rules, amount conversions, transaction structure, WASM parsing, storage estimate and no silent auto-retry.
- `BUILDAI-INTEGRATION.txt`: AI builder copy/paste instructions.
- `docs/SECURITY-GATES.md`: v0.1 inherited release blockers.

## CLI deployment alternative (testnet only)
If Meteor blocks DeployContract, use the **Deploy with NEAR CLI (Windows)** section on the published admin site. It generates local commands, never signs or sends transactions from GitHub Pages. Load the verified build; enter the named testnet owner, factory prefix and funding; check the target account does not exist; download the verified WASM; and generate PowerShell instructions. Install NEAR CLI from https://near.cli.rs/ and import your own dedicated testnet full-access signing key locally. Run the preparation command to verify the WASM hash before running the second, real deployment command. Confirm four actions (CreateAccount, Transfer, DeployContract, FunctionCall(new)) and **no AddKey**. Never send credentials to the website, GitHub, or ChatGPT. Never retry an uncertain deployment without investigating receipts.

## Setup without local coding

1. **Create a new GitHub repository**, e.g. `nearium-admin-deployer`, ideally private while reviewing the code. The admin site, if published with GitHub Pages, will itself be public. Never put secrets into the source.
2. **Upload the *contents* of this ZIP to the repository root**. The `.github/workflows` directory must be preserved; some ZIP upload methods omit hidden files. You can use GitHub's web uploader, upload each top-level folder, or GitHub Desktop. There is no need to install Rust.
3. In GitHub, go to **Settings > Pages > Build and deployment**, select **GitHub Actions** as the source. Depending on repository visibility and your plan, GitHub Pages hosting may need a public repository or alternate static hosting. Do not make security depend on keeping the admin URL secret.
4. Open the repository **Actions** tab, run `Nearium testnet contracts and admin dashboard` with **Run workflow**, and inspect each build step. If Rust compilation fails, the workflow will stop. Do **not** bypass the Rust tests or upload fabricated WASM files.
5. When every step succeeds, the deployment page displays a Pages site URL. Visit that HTTPS link; you should see a dark **Nearium Deployment Center** dashboard. The URL usually looks like `https://YOUR-GITHUB-USERNAME.github.io/nearium-admin-deployer/` for a public repository.
6. Create/fund a **separate named NEAR testnet owner wallet**. Open the published launcher and choose **Connect Wallet**. Authorize MyNearWallet and return. Some wallets cannot sign account creation/deploy actions. If your wallet refuses, use a compatible wallet signing flow; do not import private keys into the website.
7. Press **Load published build**. The admin verifies the two WASM files against SHA-256 values in the published manifest and displays their actual sizes and the full source commit. Review that commit in GitHub. The manifest is not a third-party signature or independent audit.
8. Under **Create and deploy factory**, choose prefix `launchpad` and initial funding (default `6` testnet NEAR). The new factory address is `launchpad.YOUR-OWNER.testnet`. Press **Check on-chain** first. If it doesn't exist and everything is validated, press **Deploy factory**. The wallet authorizes a *single atomic transaction* with CreateAccount + Transfer + DeployContract + `new({owner})`. No key is installed on the new factory account.
9. Wait for wallet signing and independently check the chain. When the owner and account access-key state verify, choose **Install template**. This uses a live protocol storage-byte price and attaches a calculated deposit. Because v0.1 only supports one template installation, confirm the correct hash. A browser wallet may reject unusually large transactions or gas; if so, stop and investigate rather than trying a custodial shortcut.
10. After the factory says **Installed**, fill in the **Launch test token** form. Launch requires precisely **5.02 testnet NEAR**. Check the resulting token status in the dashboard. An uncertain or failed launch should be investigated using NEAR testnet explorer; **do not automatically retry**.
11. In **BuildAI.space**, add an **Admin: Contract Deployer** link that opens the published HTTPS dashboard in a **new tab**. Do not iframe it: wallet browser redirects and popup policies can prevent iframe signing. Use `BUILDAI-INTEGRATION.txt`.
12. Connect your public Nearium token form to the deployed factory ID using the original `web/near-adapter.ts` as a reference, and update the adapter's v10 Wallet Selector action format. The admin deployer does not itself provide the public trading UX.

### What "one click" means

The first-time cloud build and wallet connection are not fully one click because they require GitHub setup, a funded testnet account, and human approval of blockchain transactions. After setup, deployment and installation are **guided buttons** with owner wallet signatures and on-chain verification. Each public token launch then becomes one factory call.

## Security architecture

```
  Existing BuildAI.space Nearium website
             |
             | HTTPS link, new tab
             v
   Public static admin UI (GitHub Pages)
       |             |
       | read        | request user-approved signatures
       v             v
  Published WASM   Owner NEAR wallet (full access, never exported)
  SHA256 manifest     |
       |              | 1. CreateAccount/Transfer/DeployContract/new
       |              | 2. install_template (owner only)
       |              | 3. launch test token
       v              v
   NEAR testnet RPC <- Factory: launchpad.owner.testnet
                          | no access keys installed
                          +---> Child token: slug.factory.testnet
```

**No backend deployment signer**: GitHub Actions does not hold private keys and never sends blockchain transactions. Only the user's wallet approves them. The dashboard always requests owner-wallet confirmation; source files and hashes are public data. No untrusted browser-provided key is permitted or stored.

**Important nuance**: The frontend's account-name restriction and wallet check are **not a server-side authentication boundary**. Anyone can copy the static UI, but without control of the owner's NEAR account they cannot install its immutable template or sign actions using that owner's keys. Access to the *admin page itself* should be additionally controlled using your site's authentication if you want a truly private page. BuildAI.space password-only client gates alone are insufficient for sensitive APIs.

**Immutable factory**: The proposed creation transaction deliberately does not include AddKey; use the account-info verifier to confirm the factory has zero access keys. Owner-controlled factory functions still work because they check the signer account, not a key stored on factory. Do not use a previously populated factory with full-access keys and assume immutability.

**Account funding**: The first deposit is storage balance, not pool liquidity or a developer fee. The launcher verifies the configured testnet funding estimate against network storage price before authorizing the transaction. Actual gas and future storage requirements can vary.

**Supply-chain**: GitHub Actions runs tests, compiles both pinned SDK source packages, and publishes a SHA-256 manifest including the Git commit SHA. The admin checks the hash of every downloaded WASM. GitHub hosting and CI are trusted infrastructure; reviewing source commit and moving to reproducible/pinned dependency builds is still needed for production.

**Asynchronous callback safety**: Existing v0.1 factory and payout-recovery issues remain unresolved; success in the interface does **not** imply the token contracts are safe. Never deploy this code to mainnet or invite public funds before an independent security audit and NEAR sandbox adversarial tests.

## Validation performed on this package

- `node --test admin/tests/core.test.mjs` passed locally (8 cases).
- `node --check admin/src/main.js` passed locally.
- Rust compiler is unavailable in the packaging environment; **Rust tests, cargo-near build, browser wallet signing, actual testnet deployment, and GitHub Pages publication have not been executed here**. The workflow stops on any compilation/test error. The end-to-end integration remains unverified.

## Reference documentation

- NEAR Wallet Selector v10 action API: https://github.com/near/wallet-selector/blob/main/MIGRATION-v10.md
- Wallet actions and browser-wallet redirects: https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md
- NEAR runtime account creation + deploy actions: https://near.github.io/nearcore/RuntimeSpec/Actions.html
- cargo-near builder: https://github.com/near/cargo-near
- NEAR RPC protocol storage pricing: https://docs.fastnear.com/rpc/protocol/experimental-protocol-config
