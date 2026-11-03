'use strict';
// NEAR 7.x: construct, sign, hash, durably guard, THEN send exact signed bytes.
// Never send/re-sign before the durable guard succeeds. Never generate a new
// signed transaction automatically when the RPC outcome is ambiguous.
const {createHash,timingSafeEqual}=require('node:crypto');
async function signPersistSend({account,journal,approved,actions,baseEncode}){
 if(!account?.getSigner||!account?.createTransaction||!account?.provider?.sendTransactionUntil)
  throw Error('NEAR signing API lacks the required transaction preparation methods.');
 const signer=account.getSigner();
 if(!signer?.signTransaction)throw Error('No local transaction signer is available.');
 await journal.assertClear(approved.network,approved.target);
 const unsigned=await account.createTransaction({
  receiverId:approved.target,actions,publicKey:approved.publicKey
 });
 if(typeof unsigned?.encode!=='function')throw Error('Unsigned transaction serialization is unavailable.');
 const encoded=Buffer.from(unsigned.encode());
 const {txHash,signedTransaction}=await signer.signTransaction(unsigned);
 if(!(txHash instanceof Uint8Array)||txHash.length!==32||!signedTransaction?.transaction||
    typeof signedTransaction.transaction.encode!=='function')
  throw Error('Signer returned an invalid signed transaction or transaction hash.');
 const expectedHash=createHash('sha256').update(encoded).digest();
 if(!timingSafeEqual(Buffer.from(txHash),expectedHash)||
    !Buffer.from(signedTransaction.transaction.encode()).equals(encoded))
  throw Error('Signer returned different transaction data or hash. Broadcast blocked.');
 const tx=unsigned;
 if(tx.signerId!==approved.signer||tx.receiverId!==approved.target||
    tx.publicKey?.toString()!==approved.publicKey||typeof tx.nonce!=='bigint'||
    tx.nonce<=0n||!(tx.blockHash instanceof Uint8Array)||tx.blockHash.length!==32)
  throw Error('Signed transaction identity, public key, nonce or block hash differs from approved deployment.');
 const hash=baseEncode(txHash),blockHash=baseEncode(tx.blockHash);
 // MUST finish filesystem flush before invoking provider.sendTransactionUntil.
 await journal.start({...approved,txHash:hash,nonce:String(tx.nonce),blockHash});
 return account.provider.sendTransactionUntil(signedTransaction,'FINAL');
}
module.exports={signPersistSend};
