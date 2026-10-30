import test from 'node:test';
import assert from 'node:assert/strict';
import { connectOrSignIn } from '../src/wallet-auth.js';

const approved=[{accountId:'testing.testnet'}];

test('Meteor first-time connect signs in before touching getAccounts',async()=>{
  const calls=[]; let connected=false;
  const wallet={
    async isSignedIn(){ calls.push('isSignedIn');return connected; },
    async signIn({contractId}){ calls.push('signIn:'+contractId);connected=true;return approved; },
    async getAccounts(){ calls.push('getAccounts'); if(!connected)throw Error('No current account connected to Meteor Wallet');return approved; },
  };
  assert.deepEqual(await connectOrSignIn(wallet),approved);
  assert.deepEqual(calls,['isSignedIn','signIn:social.testnet']);
});

test('reuses an existing session without a second sign-in',async()=>{
  let signIns=0;
  const wallet={
    async isSignedIn(){return true;},
    async getAccounts(){return approved;},
    async signIn(){signIns++;return approved;},
  };
  assert.deepEqual(await connectOrSignIn(wallet),approved);
  assert.equal(signIns,0);
});

test('stale Meteor session with no current account triggers reauthorization',async()=>{
  let signIns=0;
  const wallet={
    async isSignedIn(){return true;},
    async getAccounts(){if(!signIns)throw Error('No current account connected to Meteor Wallet');return approved;},
    async signIn(){signIns++;return approved;},
  };
  assert.deepEqual(await connectOrSignIn(wallet),approved);
  assert.equal(signIns,1);
});

test('missing Meteor account after sign-in gives actionable error',async()=>{
  const wallet={
    async isSignedIn(){return false;},
    async getAccounts(){throw Error('No current account connected to Meteor Wallet');},
    async signIn(){return [];},
  };
  await assert.rejects(()=>connectOrSignIn(wallet),/unlock it, select or create a NEAR testnet account/);
});

test('wallet approval cancellation remains a failure',async()=>{
  const wallet={
    async isSignedIn(){return false;},
    async getAccounts(){throw Error('Must never run before signIn');},
    async signIn(){throw Error('User rejected');},
  };
  await assert.rejects(()=>connectOrSignIn(wallet),/User rejected/);
});
