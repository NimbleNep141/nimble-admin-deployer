//! EXPERIMENTAL testnet-only factory. Deployment failures can leave funded child
//! accounts, and therefore MUST be integration-tested before accepting real funds.
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseResult, env, near, require,
};

const CHILD_FUNDING: u128 = 5 * 10_u128.pow(24); // Seed child's code/state/storage balance
const FACTORY_STORAGE_FEE: u128 = 20_000_000_000_000_000_000_000; // 0.02 NEAR
const LAUNCH_ATTACHED: u128 = CHILD_FUNDING + FACTORY_STORAGE_FEE;

#[derive(BorshStorageKey, BorshSerialize)]
enum Keys { Records, Slugs }

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct LaunchRecord {
    creator: AccountId,
    token_id: AccountId,
    name: String,
    symbol: String,
    status: u8, // 0 pending, 1 deployed, 2 deployment failed
}

#[near(serializers=[json])]
pub struct LaunchView {
    pub creator: AccountId,
    pub token_id: AccountId,
    pub name: String,
    pub symbol: String,
    pub status: String,
}

impl LaunchRecord {
    fn view(&self) -> LaunchView {
        LaunchView {
            creator: self.creator.clone(), token_id: self.token_id.clone(),
            name: self.name.clone(), symbol: self.symbol.clone(),
            status: match self.status { 0 => "pending", 1 => "deployed", _ => "failed" }.into(),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    template: Vec<u8>,
    installed: bool,
    launches: LookupMap<String, LaunchRecord>,
    slugs: Vector<String>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner, template: Vec::new(), installed: false,
            launches: LookupMap::new(Keys::Records),
            slugs: Vector::new(Keys::Slugs),
        }
    }

    /// Upload the immutable child WASM one time. Attached NEAR remains in factory
    /// to support its WASM template's staked storage. This is not a user launch.
    #[payable]
    pub fn install_template(&mut self, code: Base64VecU8) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(!self.installed, "template locked");
        require!(code.0.len() > 8 && code.0.len() <= 1_000_000, "invalid template size");
        require!(code.0.starts_with(&[0, 97, 115, 109]), "WASM magic mismatch");
        let prepaid = env::attached_deposit().as_yoctonear();
        // Persistent contract state is serialized after the method returns. A live
        // env::storage_usage() delta would miss these in-memory changes.
        let chargeable_bytes = (code.0.len() as u128).checked_add(64).expect("length overflow");
        let estimated = chargeable_bytes.checked_mul(env::storage_byte_cost().as_yoctonear()).expect("cost overflow");
        require!(prepaid >= estimated, "attach enough NEAR to stake template storage");
        self.template = code.0;
        self.installed = true;
    }

    /// Each launch creates a new child contract with no access keys.
    /// WARNING: `create_account` + deployment/initialization is asynchronous.
    #[payable]
    pub fn launch(&mut self, slug: String, name: String, symbol: String, icon: Option<String>) -> Promise {
        require!(self.installed, "template not installed");
        require!(env::attached_deposit().as_yoctonear() == LAUNCH_ATTACHED, "attach exactly 5.02 NEAR");
        require!((3..=32).contains(&slug.len()), "slug 3..32 characters");
        require!(slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "bad slug");
        require!(!slug.starts_with('-') && !slug.ends_with('-'), "bad slug boundaries");
        require!((3..=64).contains(&name.len()), "name 3..64 bytes");
        require!((2..=12).contains(&symbol.len()) && symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), "invalid symbol");
        require!(icon.as_ref().map_or(true, |s| s.len() <= 1024), "icon too large");
        require!(self.launches.get(&slug).is_none(), "slug already used");
        let token_id: AccountId = format!("{}.{}", slug, env::current_account_id()).parse().expect("invalid child account id");
        let creator = env::predecessor_account_id();
        self.launches.insert(&slug, &LaunchRecord {
            creator: creator.clone(), token_id: token_id.clone(),
            name: name.clone(), symbol: symbol.clone(), status: 0,
        });
        self.slugs.push(&slug);
        let args = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
            "creator": creator, "fee_recipient": self.owner.clone(),
            "name": name, "symbol": symbol, "icon": icon,
        })).unwrap();
        let callback = near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"slug":slug})).unwrap();
        Promise::new(token_id).create_account()
            .transfer(NearToken::from_yoctonear(CHILD_FUNDING))
            .deploy_contract(self.template.clone())
            .function_call("new", args, NearToken::from_yoctonear(0), Gas::from_tgas(65))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_launch_complete", callback, NearToken::from_yoctonear(0), Gas::from_tgas(18)
            ))
    }

    #[private]
    pub fn on_launch_complete(&mut self, slug: String) -> bool {
        let mut record = self.launches.get(&slug).expect("launch missing");
        require!(record.status == 0, "launch callback already processed");
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        record.status = if ok { 1 } else { 2 };
        self.launches.insert(&slug, &record);
        env::log_str(&format!("FACTORY_LAUNCH token={} status={}", record.token_id, if ok { "deployed" } else { "failed" }));
        ok
    }

    pub fn get_launch(&self, slug: String) -> Option<LaunchView> {
        self.launches.get(&slug).map(|r| r.view())
    }

    pub fn get_launches(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<LaunchView> {
        let start = from_index.unwrap_or(0).min(self.slugs.len());
        let end = start.saturating_add(limit.unwrap_or(20).min(50)).min(self.slugs.len());
        (start..end).filter_map(|i| self.slugs.get(i))
            .filter_map(|s| self.launches.get(&s))
            .map(|r| r.view()).collect()
    }

    pub fn get_launch_count(&self) -> u64 { self.slugs.len() }
    pub fn get_launch_cost_yocto(&self) -> U128 { U128(LAUNCH_ATTACHED) }
    pub fn is_template_installed(&self) -> bool { self.installed }
    pub fn get_owner(&self) -> AccountId { self.owner.clone() }
}
