/**
 * Authorize a NEAR Wallet Selector adapter before requesting its active account.
 * Meteor's getAccounts() can throw when called before the first sign-in.
 * Do not store keys or sign transactions here.
 */
export async function connectOrSignIn(wallet, {beforeSignIn=async()=>{}, contractId='social.testnet'}={}) {
  if (!wallet || typeof wallet.isSignedIn !== 'function' ||
      typeof wallet.getAccounts !== 'function' || typeof wallet.signIn !== 'function') {
    throw new Error('Wallet provider does not implement the required connection methods.');
  }

  const isMissingMeteorAccount = e =>
    /No current account connected to Meteor Wallet/i.test(String(e?.message ?? e));

  const signIn = async () => {
    await beforeSignIn();
    try {
      const granted=await wallet.signIn({contractId});
      if (Array.isArray(granted) && granted.length) return granted;
      return await wallet.getAccounts();
    } catch(e) {
      if (isMissingMeteorAccount(e)) {
        throw new Error('Meteor Wallet has no active account. Open Meteor Wallet, unlock it, select or create a NEAR testnet account, and try connecting again.');
      }
      throw e;
    }
  };

  let signedIn;
  try { signedIn=await wallet.isSignedIn(); }
  catch(e) {
    if (!isMissingMeteorAccount(e)) throw e;
    signedIn=false;
  }

  // Never call getAccounts before signIn on an unconnected Meteor wallet.
  if (!signedIn) return signIn();

  try {
    const accounts=await wallet.getAccounts();
    if (accounts.length) return accounts;
  } catch(e) {
    if (!isMissingMeteorAccount(e)) throw e;
  }
  // The SDK claims to be signed in, but there is no active account. Reauthorize.
  return signIn();
}
