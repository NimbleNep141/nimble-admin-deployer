/** Browser integration adapter. Replace WalletAdapter with your connected wallet-selector wallet.
 * NOT a hosted site or deployed contract. All financial quantities use bigint/string.
 */
export const NEAR_DECIMALS = 24n;
export const TOKEN_DECIMALS = 18n;
export const YOCTO = 10n ** NEAR_DECIMALS;
export const GAS = '160000000000000';
export const MIN_TRADE_GAS = '60000000000000';
export const FIRST_SELL_STORAGE = 5n * 10n ** 21n;

export type WalletAction = { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } };
export interface WalletAdapter {
  signAndSendTransaction(input: { receiverId: string; actions: WalletAction[] }): Promise<unknown>;
}

function action(methodName: string, args: Record<string, unknown>, deposit = 0n, gas = MIN_TRADE_GAS): WalletAction {
  return { type: 'FunctionCall', params: { methodName, args, gas, deposit: deposit.toString() } };
}

export function parseUnits(s: string, decimals: bigint): bigint {
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = s.split('.');
  if (BigInt(fraction.length) > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  return BigInt(whole) * 10n ** decimals + BigInt((fraction.padEnd(Number(decimals), '0')) || '0');
}

export function formatUnits(amount: bigint, decimals: bigint, maxFraction = 6): string {
  const div = 10n ** decimals;
  const whole = amount / div;
  const fraction = (amount % div).toString().padStart(Number(decimals), '0').slice(0, maxFraction).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function minWithSlippage(quote: string, slippageBps = 100): string {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('Invalid slippage');
  return (BigInt(quote) * BigInt(10_000 - slippageBps) / 10_000n).toString();
}

export async function view<T>(rpcUrl: string, contractId: string, methodName: string, args: object = {}): Promise<T> {
  const argsBytes = new TextEncoder().encode(JSON.stringify(args));
  // Works in modern browsers with btoa (Node/browser users can replace encoding).
  const encoded = btoa(String.fromCharCode(...argsBytes));
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'curve-query', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName, args_base64: encoded } }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  const text = new TextDecoder().decode(new Uint8Array(body.result.result));
  return JSON.parse(text) as T;
}

export const RPC = {
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
};

export interface BuyQuote { tokens_out: string; trading_fee_yocto: string; deposited_to_reserve_yocto: string }
export interface SellQuote { payout_yocto: string; trading_fee_yocto: string; debited_from_reserve_yocto: string; first_sell_storage_if_unregistered_yocto: string }
export interface CurveState { fixed_supply: string; sold_on_curve: string; curve_tokens_remaining: string; real_near_reserve_yocto: string; virtual_near_reserve_yocto: string; virtual_token_reserve: string; fee_bps: number; has_graduated: boolean }

export async function quoteBuy(rpcUrl: string, tokenId: string, grossNear: string): Promise<BuyQuote> {
  return view(rpcUrl, tokenId, 'quote_buy', { gross_near: parseUnits(grossNear, NEAR_DECIMALS).toString() });
}

export async function quoteSell(rpcUrl: string, tokenId: string, tokenAmount: string): Promise<SellQuote> {
  return view(rpcUrl, tokenId, 'quote_sell', { tokens: parseUnits(tokenAmount, TOKEN_DECIMALS).toString() });
}

/** Single wallet transaction: storage registration action followed by buy action.
 * It registers at the exact NEP-145 minimum; if already registered, skip it.
 */
export async function buyTokens(wallet: WalletAdapter, rpcUrl: string, tokenId: string, buyerId: string, grossNear: string, slippageBps = 100) {
  const gross = parseUnits(grossNear, NEAR_DECIMALS);
  const quote = await view<BuyQuote>(rpcUrl, tokenId, 'quote_buy', { gross_near: gross.toString() });
  const balance = await view<unknown>(rpcUrl, tokenId, 'storage_balance_of', { account_id: buyerId });
  const actions: WalletAction[] = [];
  if (!balance) {
    const storage = await view<{ min: string }>(rpcUrl, tokenId, 'storage_balance_bounds');
    actions.push(action('storage_deposit', { account_id: buyerId, registration_only: true }, BigInt(storage.min)));
  }
  actions.push(action('buy', { min_tokens_out: minWithSlippage(quote.tokens_out, slippageBps) }, gross));
  return wallet.signAndSendTransaction({ receiverId: tokenId, actions });
}

/** quote_sell reflects buyer-independent pricing but first-sell deposit is seller-specific.
 * Only call from the intended seller wallet. No FT approvals are necessary.
 */
export async function sellTokens(wallet: WalletAdapter, rpcUrl: string, tokenId: string, sellerId: string, tokenAmount: string, slippageBps = 100) {
  const tokens = parseUnits(tokenAmount, TOKEN_DECIMALS);
  const quote = await view<SellQuote>(rpcUrl, tokenId, 'quote_sell', { tokens: tokens.toString() });
  // `quote_sell` runs in a view context, where predecessor isn't the user's wallet.
  // Therefore find the first-sell deposit from a separate explicit registration getter.
  const registered = await view<boolean>(rpcUrl, tokenId, 'has_payout_registration', { account_id: sellerId });
  const attached = registered ? 1n : FIRST_SELL_STORAGE;
  return wallet.signAndSendTransaction({ receiverId: tokenId, actions: [
    action('sell', { amount: tokens.toString(), min_near_out: minWithSlippage(quote.payout_yocto, slippageBps) }, attached),
  ] });
}

export async function withdrawProceeds(wallet: WalletAdapter, tokenId: string) {
  return wallet.signAndSendTransaction({ receiverId: tokenId, actions: [action('withdraw_proceeds', {}, 1n)] });
}

export async function launchToken(wallet: WalletAdapter, factoryId: string, input: { slug: string; name: string; symbol: string; icon?: string | null }) {
  return wallet.signAndSendTransaction({ receiverId: factoryId, actions: [
    action('launch', { slug: input.slug, name: input.name, symbol: input.symbol, icon: input.icon ?? null }, 5_020_000_000_000_000_000_000_000n, GAS),
  ] });
}
