'use strict';
const {createHash,timingSafeEqual}=require('node:crypto');
// Never ask NEAR SDK to create a replacement transaction after a lost response.
// Prepare, sign, hash and record the EXACT bytes before first broadcast.
async function signAndSubmitExact({account,journal,approved,actions,baseEncode}){
 if(!account?.getSigner||!account?.createTransaction||!account?.provider?.sendTransactionUntil)
  throw Error('Required NEAR signing interface unavailable. Broadcast disabled.');
 const signer=account.getSigner();
 if(!signer?.signTransaction)throw Error('Local signer does not support separate transaction signing.');
 await journal.assertClear(approved.network,approved.target);
 const tx=await account.createTransaction({
  receiverId:approved.target,actions,publicKey:approved.publicKey
 });
 if(typeof tx?.encode!=='function')throw Error('SDK transaction serialization unavailable.');
 const unsignedBytes=Buffer.from(tx.encode());
 const signed=await signer.signTransaction(tx);
 if(!(signed?.txHash instanceof Uint8Array)||signed.txHash.length!==32||
  typeof signed?.signedTransaction?.transaction?.encode!=='function')
  throw Error('Signer returned an invalid transaction.');
 const expected=createHash('sha256').update(unsignedBytes).digest();
 if(!timingSafeEqual(expected,Buffer.from(signed.txHash))||
  !Buffer.from(signed.signedTransaction.transaction.encode()).equals(unsignedBytes))
  throw Error('Signed transaction bytes or hash differ from the approved transaction.');
 if(tx.signerId!==approved.signer||tx.receiverId!==approved.target||
  tx.publicKey?.toString()!==approved.publicKey||
  typeof tx.nonce!=='bigint'||tx.nonce<=0n||
  !(tx.blockHash instanceof Uint8Array)||tx.blockHash.length!==32)
  throw Error('Signed transaction identity or nonce is invalid. Nothing broadcast.');
 const original=await journal.start({...approved,txHash:baseEncode(signed.txHash),
  nonce:String(tx.nonce),blockHash:baseEncode(tx.blockHash)});
 // Exclusive transition: cancellation and broadcast compete for ONE immutable phase
 // filename. A cancellation that wins prevents any send.
 await journal.claimBroadcast(original);
 // Re-check exact signed bytes after any asynchronous file writes.
 if(!Buffer.from(signed.signedTransaction.transaction.encode()).equals(unsignedBytes))
  throw Error('Signed transaction was altered after recording. Broadcast blocked; intent retained.');
 return account.provider.sendTransactionUntil(signed.signedTransaction,'FINAL');
}
module.exports={signAndSubmitExact};
