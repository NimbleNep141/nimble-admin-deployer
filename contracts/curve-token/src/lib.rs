//! EXPERIMENTAL, UNAUDITED. TESTNET ONLY. No DEX graduation in this milestone.
//! Each token is its own NEP-141 fungible token AND native-NEAR curve market.
//! There is no mint method, upgrade method, owner withdrawal of curve reserve,
//! or admin price setter. No full-access keys should be put on factory-created accounts.
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LazyOption, LookupMap};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult, assert_one_yocto, env, near, require,
};
use primitive_types::U256;

const UNIT: u128 = 1_000_000_000_000_000_000; // token has 18 decimals
pub const TOTAL_SUPPLY: u128 = 1_000_000_000 * UNIT;
const VIRTUAL_TOKENS: u128 = 1_200_000_000 * UNIT;
const VIRTUAL_NEAR: u128 = 5 * 10_u128.pow(24); // 5 NEAR
const FEE_BPS: u128 = 100; // 1% on buys and sells, fixed
const BPS: u128 = 10_000;
// One-time extra NEAR for each SELLER claim ledger; not part of the curve.
const SELLER_STORAGE: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(12);

#[derive(BorshSerialize, BorshStorageKey)]
enum Keys {
    Token,
    Metadata,
    Claims,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct BuyQuote {
    pub tokens_out: U128,
    pub trading_fee_yocto: U128,
    pub deposited_to_reserve_yocto: U128,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct SellQuote {
    pub payout_yocto: U128,
    pub trading_fee_yocto: U128,
    pub debited_from_reserve_yocto: U128,
    pub first_sell_storage_if_unregistered_yocto: U128,
}

#[near(serializers = [json])]
pub struct CurveState {
    pub fixed_supply: U128,
    pub sold_on_curve: U128,
    pub curve_tokens_remaining: U128,
    pub real_near_reserve_yocto: U128,
    pub virtual_near_reserve_yocto: U128,
    pub virtual_token_reserve: U128,
    pub fees_accrued_yocto: U128,
    pub fee_bps: u16,
    pub fee_recipient: AccountId,
    pub creator: AccountId,
    pub has_graduated: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CurveToken {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    creator: AccountId,
    fee_recipient: AccountId,
    sold: u128,
    reserve: u128,
    fees_accrued: u128,
    claimable: LookupMap<AccountId, u128>,
}

fn mul_div_floor(a: u128, b: u128, c: u128) -> u128 {
    require!(c != 0, "division by zero");
    let product = U256::from(a)
        .checked_mul(U256::from(b))
        .expect("256-bit multiplication overflow");
    let value = product / U256::from(c);
    require!(value <= U256::from(u128::MAX), "quote overflow");
    value.as_u128()
}

#[near]
impl CurveToken {
    #[init]
    pub fn new(
        creator: AccountId,
        fee_recipient: AccountId,
        name: String,
        symbol: String,
        icon: Option<String>,
    ) -> Self {
        // Only the parent factory can initialize its new subaccounts. This prevents
        // any other actor from hijacking an uninitialized child on failed deployment.
        let current = env::current_account_id();
        let (_, parent) = current.as_str().split_once('.').expect("must be a subaccount");
        require!(env::predecessor_account_id().as_str() == parent, "factory only");
        require!((3..=64).contains(&name.len()), "name must be 3..64 bytes");
        require!((2..=12).contains(&symbol.len()), "symbol must be 2..12 bytes");
        require!(symbol.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), "uppercase A-Z and numbers only");
        require!(icon.as_ref().map_or(true, |s| s.len() <= 1024), "icon exceeds 1024 bytes");

        let md = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_owned(), name, symbol, icon,
            reference: None, reference_hash: None, decimals: 18,
        };
        md.assert_valid();
        let mut token = FungibleToken::new(Keys::Token);
        token.internal_register_account(&current);
        token.internal_deposit(&current, TOTAL_SUPPLY);
        Self {
            token,
            metadata: LazyOption::new(Keys::Metadata, Some(&md)),
            creator,
            fee_recipient,
            sold: 0,
            reserve: 0,
            fees_accrued: 0,
            claimable: LookupMap::new(Keys::Claims),
        }
    }

    /// Buying requires NEP-145 registration. Attach the exact gross NEAR amount.
    #[payable]
    pub fn buy(&mut self, min_tokens_out: U128) -> BuyQuote {
        let buyer = env::predecessor_account_id();
        require!(self.token.accounts.contains_key(&buyer), "register via storage_deposit first");
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= 1_000_000_000_000_000_000_000, "minimum buy is 0.001 NEAR");
        let quote = self.quote_buy(U128(attached));
        let output = quote.tokens_out.0;
        require!(output > 0, "buy returns zero tokens");
        require!(output >= min_tokens_out.0, "slippage: fewer tokens than requested");
        require!(output <= TOTAL_SUPPLY - self.sold, "curve sold out: reduce buy size");
        self.sold = self.sold.checked_add(output).expect("sold overflow");
        self.reserve = self.reserve.checked_add(quote.deposited_to_reserve_yocto.0).expect("reserve overflow");
        self.fees_accrued = self.fees_accrued.checked_add(quote.trading_fee_yocto.0).expect("fee overflow");
        self.token.internal_transfer(&env::current_account_id(), &buyer, output, Some("bonding-curve buy".into()));
        env::log_str(&format!("CURVE_BUY buyer={} paid_yocto={} tokens={}", buyer, attached, output));
        quote
    }

    /// A seller's first trade needs 0.005 NEAR for a permanent payout-ledger slot.
    /// Later sells attach exactly 1 yoctoNEAR as a wallet-authentication guard.
    #[payable]
    pub fn sell(&mut self, amount: U128, min_near_out: U128) -> SellQuote {
        let seller = env::predecessor_account_id();
        require!(amount.0 > 0 && amount.0 <= self.sold, "invalid sell amount");
        let first_sell = !self.claimable.contains_key(&seller);
        let expected = if first_sell { SELLER_STORAGE } else { 1 };
        require!(env::attached_deposit().as_yoctonear() == expected, "incorrect seller registration deposit");
        let quote = self.quote_sell(amount);
        require!(quote.payout_yocto.0 > 0, "sell returns zero NEAR");
        require!(quote.payout_yocto.0 >= min_near_out.0, "slippage: payout below minimum");
        let previous_claim = self.claimable.get(&seller).unwrap_or(0);
        let next_claim = previous_claim.checked_add(quote.payout_yocto.0).expect("claim overflow");
        self.token.internal_transfer(&seller, &env::current_account_id(), amount.0, Some("bonding-curve sell".into()));
        self.sold -= amount.0;
        self.reserve = self.reserve.checked_sub(quote.debited_from_reserve_yocto.0).expect("reserve underflow");
        self.fees_accrued = self.fees_accrued.checked_add(quote.trading_fee_yocto.0).expect("fee overflow");
        self.claimable.insert(&seller, &next_claim);
        env::log_str(&format!("CURVE_SELL seller={} tokens={} claim_yocto={}", seller, amount.0, quote.payout_yocto.0));
        quote
    }

    /// Withdraw proceeds via pull payments. Callback restores the claim on failure.
    #[payable]
    pub fn withdraw_proceeds(&mut self) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let amount = self.claimable.get(&who).unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.claimable.insert(&who, &0);
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_proceeds_withdrawn",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"account_id":who,"amount":U128(amount)})).unwrap(),
                NearToken::from_yoctonear(0), WITHDRAW_CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_proceeds_withdrawn(&mut self, account_id: AccountId, amount: U128) -> bool {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) { return true; }
        let existing = self.claimable.get(&account_id).unwrap_or(0);
        self.claimable.insert(&account_id, &existing.checked_add(amount.0).expect("restore overflow"));
        false
    }

    /// Fee withdrawal cannot touch the tracked NEAR curve reserve or user claims.
    #[payable]
    pub fn withdraw_fees(&mut self) -> Promise {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.fee_recipient, "fee recipient only");
        let amount = self.fees_accrued;
        require!(amount > 0, "no fees");
        self.fees_accrued = 0;
        Promise::new(self.fee_recipient.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_fees_withdrawn",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"amount":U128(amount)})).unwrap(),
                NearToken::from_yoctonear(0), WITHDRAW_CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_fees_withdrawn(&mut self, amount: U128) -> bool {
        if matches!(env::promise_result(0), PromiseResult::Successful(_)) { return true; }
        self.fees_accrued = self.fees_accrued.checked_add(amount.0).expect("restore overflow");
        false
    }

    pub fn quote_buy(&self, gross_near: U128) -> BuyQuote {
        let fee = mul_div_floor(gross_near.0, FEE_BPS, BPS);
        let net = gross_near.0.checked_sub(fee).expect("fee exceeded payment");
        let virtual_tokens_left = VIRTUAL_TOKENS - self.sold;
        let virtual_near_now = VIRTUAL_NEAR.checked_add(self.reserve).expect("near reserve overflow");
        let output = mul_div_floor(virtual_tokens_left, net,
            virtual_near_now.checked_add(net).expect("near price overflow"));
        BuyQuote { tokens_out: U128(output), trading_fee_yocto: U128(fee), deposited_to_reserve_yocto: U128(net) }
    }

    pub fn quote_sell(&self, tokens: U128) -> SellQuote {
        require!(tokens.0 > 0 && tokens.0 <= self.sold, "invalid sell quantity");
        let virtual_near_now = VIRTUAL_NEAR.checked_add(self.reserve).expect("near reserve overflow");
        let virtual_tokens_left = VIRTUAL_TOKENS - self.sold;
        let gross = mul_div_floor(virtual_near_now, tokens.0,
            virtual_tokens_left.checked_add(tokens.0).expect("token denominator overflow"));
        require!(gross <= self.reserve, "not enough curve reserve");
        let fee = mul_div_floor(gross, FEE_BPS, BPS);
        let payout = gross - fee;
        SellQuote {
            payout_yocto: U128(payout), trading_fee_yocto: U128(fee),
            debited_from_reserve_yocto: U128(gross),
            first_sell_storage_if_unregistered_yocto: U128(SELLER_STORAGE), // upper bound; query has_payout_registration for actual requirement
        }
    }

    pub fn has_payout_registration(&self, account_id: AccountId) -> bool {
        self.claimable.contains_key(&account_id)
    }

    pub fn claimable_proceeds(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).unwrap_or(0))
    }

    pub fn get_curve(&self) -> CurveState {
        CurveState {
            fixed_supply: U128(TOTAL_SUPPLY), sold_on_curve: U128(self.sold),
            curve_tokens_remaining: U128(TOTAL_SUPPLY-self.sold),
            real_near_reserve_yocto: U128(self.reserve),
            virtual_near_reserve_yocto: U128(VIRTUAL_NEAR+self.reserve),
            virtual_token_reserve: U128(VIRTUAL_TOKENS-self.sold),
            fees_accrued_yocto: U128(self.fees_accrued), fee_bps: FEE_BPS as u16,
            fee_recipient: self.fee_recipient.clone(), creator: self.creator.clone(), has_graduated: false,
        }
    }
}

#[near]
impl FungibleTokenCore for CurveToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for CurveToken {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 { env::log_str(&format!("NEP141_RESOLVE_BURN amount={}", burned)); }
        U128(used)
    }
}

#[near]
impl StorageManagement for CurveToken {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Seller payout records remain independently claimable even if FT is unregistered.
        self.token.internal_storage_unregister(force).is_some()
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
}

#[near]
impl FungibleTokenMetadataProvider for CurveToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata { self.metadata.get().expect("metadata missing") }
}
